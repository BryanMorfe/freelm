import type { ChatActivityPart, ToolCallRecord } from '../agent-types';
import type { Message } from '../types';
import { isVideoFile } from './generated-video';
import { editedFileChanges, type EditedFileChange } from './edited-files';

export interface MessageActivityPresentation {
	finalText: string;
	intermediate: ChatActivityPart[];
	callsById: Map<string, ToolCallRecord>;
	/** Asset-bearing calls stay visible when the rest of the activity is collapsed. */
	imageCalls: ToolCallRecord[];
	hasActivity: boolean;
}

/** Keeps provider rounds in order without exposing the aggregate content twice. */
export function splitMessageActivity(message: Message): MessageActivityPresentation {
	const calls = message.toolCalls || [];
	const callsById = new Map(calls.map((call) => [call.id, call]));
	const timeline = message.activity || [];
	const intermediate: ChatActivityPart[] = [];
	const referenced = new Set<string>();
	let finalText = message.content;
	if (timeline.length) {
		// A round followed by a tool is an intermediate assistant update. Only the
		// final text after every requested tool can be the completed answer.
		let lastToolIndex = -1;
		let finalTextIndex = -1;
		for (let index = 0; index < timeline.length; index++) {
			const part = timeline[index];
			if (part.type === 'tool') lastToolIndex = index;
			else if (part.text.trim()) finalTextIndex = index;
		}
		if (finalTextIndex <= lastToolIndex) finalTextIndex = -1;
		finalText = finalTextIndex < 0 ? '' : (timeline[finalTextIndex] as { text: string }).text;
		for (const [index, part] of timeline.entries()) {
			if (part.type === 'text') {
				if (index !== finalTextIndex && part.text.trim()) intermediate.push(part);
			} else if (!referenced.has(part.toolCallId) && callsById.has(part.toolCallId)) {
				referenced.add(part.toolCallId);
				intermediate.push(part);
			}
		}
	}
	// Saved messages from older clients may have tools without a timeline. Never
	// discard those records or infer that their entire content was intermediate.
	for (const call of calls) {
		if (!referenced.has(call.id)) {
			referenced.add(call.id);
			intermediate.push({ type: 'tool', id: `unreferenced-${call.id}`, toolCallId: call.id });
		}
	}
	const imageCalls = calls.filter(
		(call) =>
			call.name === 'image_gen.imagegen' ||
			call.name === 'video_gen.videogen' ||
			call.result?.content.some(isVideoFile) ||
			(call.name !== 'image.view' &&
				call.result?.content.some(
					(content) => content.type === 'image' && content.purpose !== 'computer',
				)),
	);
	return {
		finalText,
		intermediate,
		callsById,
		imageCalls,
		hasActivity:
			intermediate.length > 0 || !!message.phase || typeof message.activityFinishedAt === 'number',
	};
}

export function toolArguments(call: ToolCallRecord): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(call.arguments);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		// Arguments can still be incomplete while the provider is streaming.
	}
	return {};
}

function firstEntry(value: unknown): Record<string, unknown> {
	if (!Array.isArray(value)) return {};
	return value.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) || {};
}

function concise(value: unknown, maximum = 160): string {
	if (typeof value !== 'string') return '';
	const text = value.replace(/\s+/g, ' ').trim();
	return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function pageLabel(value: unknown): string {
	const ref = concise(value);
	try {
		const url = new URL(ref);
		if (url.protocol === 'https:' || url.protocol === 'http:') return url.hostname;
	} catch {
		// A session reference is not necessarily a URL.
	}
	return '';
}

interface CommandActivity {
	command?: string;
	sessionId?: string;
	exitCode?: number | null;
	exited: boolean;
}

function commandSessionId(call: ToolCallRecord, process = commandActivity(call)): string {
	const args = toolArguments(call);
	return (
		process?.sessionId ||
		(call.name === 'write_stdin' && typeof args.session_id === 'string' ? args.session_id : '')
	);
}

function commandActivity(call: ToolCallRecord): CommandActivity | undefined {
	if (call.name !== 'exec_command' && call.name !== 'write_stdin') return;
	if (call.result?.process)
		return { ...call.result.process, exited: call.result.process.exitCode !== undefined };
	// Older saved calls have only the model-facing JSON result. New host metadata
	// remains usable even when the output text is truncated by the agent budget.
	for (const part of call.result?.content || []) {
		if (part.type !== 'text') continue;
		try {
			const result: unknown = JSON.parse(part.text);
			if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
			const process = result as Record<string, unknown>;
			const hasExitCode = Object.hasOwn(process, 'exit_code');
			if (typeof process.session_id === 'string' || hasExitCode)
				return {
					sessionId: typeof process.session_id === 'string' ? process.session_id : undefined,
					exited: hasExitCode,
					exitCode:
						typeof process.exit_code === 'number' || process.exit_code === null
							? process.exit_code
							: undefined,
				};
		} catch {
			// Interrupted or truncated legacy results can be incomplete.
		}
	}
}

/** Resolve process polls once so a finished session updates its original command too. */
function commandSessions(calls: readonly ToolCallRecord[], runFinished = false) {
	const sessions = new Map<string, CommandActivity>();
	for (const call of calls) {
		if (call.name !== 'exec_command' && call.name !== 'write_stdin') continue;
		const process = commandActivity(call);
		const args = toolArguments(call);
		const sessionId = commandSessionId(call, process);
		if (!sessionId) continue;
		const previous = sessions.get(sessionId);
		const command =
			process?.command ||
			(call.name === 'exec_command' && typeof args.cmd === 'string' ? args.cmd : previous?.command);
		sessions.set(sessionId, {
			sessionId,
			command,
			exitCode: process?.exitCode !== undefined ? process.exitCode : previous?.exitCode,
			// The host stops outstanding processes when the model run ends or is
			// cancelled, even if the model never makes a final write_stdin poll.
			exited: runFinished || !!previous?.exited || !!process?.exited,
		});
	}
	return sessions;
}

export function toolActivityLabels(
	calls: readonly ToolCallRecord[],
	runFinished = false,
): Map<string, string> {
	const sessions = commandSessions(calls, runFinished);
	return new Map(calls.map((call) => [call.id, toolActivityLabel(call, sessions)]));
}

const cachedFileChanges = new WeakMap<
	ToolCallRecord,
	{
		arguments: string;
		status: ToolCallRecord['status'];
		result: ToolCallRecord['result'];
		files: EditedFileChange[];
	}
>();

/** History may contain the native object contract or an older freeform patch string. */
function activityPatchArgument(value: unknown): unknown {
	if (typeof value === 'string') {
		if (value.startsWith('*** Begin Patch')) return value;
		try {
			value = JSON.parse(value);
		} catch {
			return;
		}
	}
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && !Array.isArray(value))
		return (value as { patch?: unknown }).patch;
}

/** Qualified tool names share the same editing category as the built-in tool. */
export function isFileEditingCall(call: ToolCallRecord): boolean {
	return /(?:^|[._])apply_patch$/.test(call.name);
}

/** Parse patch evidence once per changed call, rather than on every streaming update. */
export function editedFileActivityChanges(call: ToolCallRecord): EditedFileChange[] {
	const cached = cachedFileChanges.get(call);
	if (
		cached &&
		cached.arguments === call.arguments &&
		cached.status === call.status &&
		cached.result === call.result
	)
		return cached.files;
	const files = editedFileChanges(call, activityPatchArgument(call.arguments));
	cachedFileChanges.set(call, {
		arguments: call.arguments,
		status: call.status,
		result: call.result,
		files,
	});
	return files;
}

/** Count actual paths without retaining another collection of diff previews. */
export function editedFileActivityCount(calls: readonly ToolCallRecord[]): number | undefined {
	const paths = new Set<string>();
	const pathKey = (path: string) =>
		`${path.startsWith('/') ? '/' : ''}${path
			.split('/')
			.filter((part) => part && part !== '.')
			.join('/')}`;
	for (const call of calls) {
		const changes = editedFileActivityChanges(call);
		// Unknown legacy edits must not turn into an invented file count.
		if (!changes.length) return;
		for (const change of changes) {
			if (change.kind === 'move' && change.previousPath) paths.delete(pathKey(change.previousPath));
			paths.add(pathKey(change.path));
		}
	}
	return paths.size;
}

/** Natural status text shared by the active label and the expanded history. */
export function toolActivityLabel(
	call: ToolCallRecord,
	sessions?: ReadonlyMap<string, CommandActivity>,
): string {
	const failed = call.status === 'failed' || call.status === 'denied' || !!call.result?.isError;
	const label = (active: string, completed: string, failure: string) =>
		failed ? failure : call.status === 'completed' ? completed : active;
	if (isFileEditingCall(call)) {
		const count = editedFileActivityCount([call]);
		const files = count === undefined ? 'files' : `${count} ${count === 1 ? 'file' : 'files'}`;
		return label(`Editing ${files}`, `Edited ${files}`, `Could not edit ${files}`);
	}
	const args = toolArguments(call);
	if (call.name.startsWith('computer_')) {
		const app = call.result?.computer?.app.name || 'app';
		if (call.name === 'computer_apps')
			return label('Finding apps', 'Found apps', 'Could not find apps');
		if (call.name === 'computer_open')
			return label('Opening app', `Opened ${app}`, 'Could not open app');
		if (call.name === 'computer_observe')
			return label('Viewing app', `Viewed ${app}`, 'Could not view app');
		if (call.name === 'computer_close')
			return label('Ending app access', `Ended access to ${app}`, 'Could not end app access');
		const action = args.action as { type?: string } | undefined;
		const verbs: Record<string, [string, string]> = {
			click: ['Clicking in', 'Clicked in'],
			drag: ['Dragging in', 'Dragged in'],
			double_click: ['Double-clicking in', 'Double-clicked in'],
			scroll: ['Scrolling in', 'Scrolled in'],
			type: ['Typing in', 'Typed in'],
			key: ['Pressing a key in', 'Pressed a key in'],
			press: ['Selecting an element in', 'Selected an element in'],
			set_value: ['Entering text in', 'Entered text in'],
		};
		const verb = verbs[action?.type || ''] || ['Using', 'Used'];
		return label(`${verb[0]} ${app}`, `${verb[1]} ${app}`, `Could not interact with ${app}`);
	}
	if (call.name === 'exec_command' || call.name === 'write_stdin') {
		const process = commandActivity(call);
		const sessionId = commandSessionId(call, process);
		const session = sessionId ? sessions?.get(sessionId) : undefined;
		// Keep shell whitespace intact, including quoted spaces and multiline scripts.
		const command =
			call.name === 'exec_command' && typeof args.cmd === 'string'
				? args.cmd
				: process?.command || session?.command;
		if (command?.trim()) {
			if (failed) return `Could not run ${command}`;
			const exited = session?.exited || process?.exited;
			const verb =
				call.status === 'running' || call.status === 'approval'
					? 'Running'
					: exited || (call.status === 'completed' && !process)
						? 'Ran'
						: call.status === 'completed'
							? 'Running'
							: 'Command:';
			return `${verb} ${command}`;
		}
		if (call.name === 'exec_command')
			return label('Running a command', 'Ran command', 'Could not run command');
	}
	if (call.name === 'conversations.search') {
		const query = concise(args.query);
		const suffix = query ? ` for ${query}` : '';
		return label(
			`Searching conversations${suffix}`,
			`Searched conversations${suffix}`,
			`Could not search conversations${suffix}`,
		);
	}
	if (call.name === 'memory.search') {
		const query = concise(args.query);
		const suffix = query ? ` for ${query}` : '';
		return label(
			`Searching memories${suffix}`,
			`Searched memories${suffix}`,
			`Could not search memories${suffix}`,
		);
	}
	if (call.name === 'view_image' || call.name === 'image.view') {
		const reference = call.name === 'view_image' ? args.path : args.target;
		const suffix = typeof reference === 'string' && reference.trim() ? `: ${reference.trim()}` : '';
		const image = call.name === 'view_image' ? 'an image' : 'a web image';
		return label(
			`Viewing ${image}${suffix}`,
			`Viewed ${image}${suffix}`,
			`Could not view ${image}${suffix}`,
		);
	}
	if (call.name === 'python.exec')
		return label('Running Python', 'Ran Python', 'Could not run Python');
	if (call.name === 'web.run') {
		const search = firstEntry(args.search_query);
		const images = firstEntry(args.image_query);
		if (Array.isArray(args.search_query)) {
			const query = concise(search.q);
			return query
				? label(`Searching for ${query}`, `Searched for ${query}`, `Could not search for ${query}`)
				: label('Searching the web', 'Searched the web', 'Could not search the web');
		}
		if (Array.isArray(args.image_query)) {
			const query = concise(images.q);
			const suffix = query ? ` of ${query}` : '';
			return label(
				`Searching for images${suffix}`,
				`Searched for images${suffix}`,
				`Could not search for images${suffix}`,
			);
		}
		if (Array.isArray(args.screenshot))
			return label('Viewing PDF pages', 'Viewed PDF pages', 'Could not view PDF pages');
		if (Array.isArray(args.find)) {
			const pattern = concise(firstEntry(args.find).pattern);
			return pattern
				? label(`Finding ${pattern}`, `Searched for ${pattern}`, `Could not find ${pattern}`)
				: label(
						'Finding text on the web',
						'Searched text on the web',
						'Could not find text on the web',
					);
		}
		if (Array.isArray(args.click))
			return label('Following a web link', 'Followed a web link', 'Could not follow a web link');
		const page = pageLabel(firstEntry(args.open).ref_id);
		return page
			? label(`Reading ${page}`, `Read ${page}`, `Could not read ${page}`)
			: label('Reading web pages', 'Read web pages', 'Could not read web pages');
	}
	const labels: Record<string, [string, string, string]> = {
		write_stdin: [
			'Interacting with a process',
			'Interacted with a process',
			'Could not interact with a process',
		],
		apply_patch: ['Editing files', 'Edited files', 'Could not edit files'],
		update_plan: ['Updating the plan', 'Updated the plan', 'Could not update the plan'],
		request_user_input: [
			'Waiting for your answer',
			'Received your answer',
			'Did not receive your answer',
		],
		send_message_to_user_async: [
			'Sharing an update',
			'Shared an update',
			'Could not share an update',
		],
		tool_search: ['Finding tools', 'Searched for tools', 'Could not find tools'],
		'image_gen.imagegen': [
			'Generating an image',
			'Generated an image',
			'Could not generate an image',
		],
		'video_gen.videogen': ['Generating a video', 'Generated a video', 'Could not generate a video'],
		'skills.list': ['Discovering skills', 'Listed skills', 'Could not discover skills'],
		'skills.read': ['Reading a skill', 'Read a skill', 'Could not read a skill'],
		'conversations.read': [
			'Reading a conversation',
			'Read a conversation',
			'Could not read a conversation',
		],
		'memory.read': ['Reading a memory', 'Read a memory', 'Could not read a memory'],
		'memory.create': ['Saving a memory', 'Saved a memory', 'Could not save a memory'],
		'memory.update': ['Updating a memory', 'Updated a memory', 'Could not update a memory'],
		'memory.delete': ['Forgetting a memory', 'Forgot a memory', 'Could not forget a memory'],
	};
	if (Object.hasOwn(labels, call.name)) return label(...labels[call.name]);
	const tool = call.name.replace(/^mcp_/, '').replace(/[._]+/g, ' ');
	return label(`Using ${tool}`, `Used ${tool}`, `Could not use ${tool}`);
}

type ToolActivityPart = Extract<ChatActivityPart, { type: 'tool' }>;
export type ActivityHistoryEntry =
	| { type: 'part'; part: ChatActivityPart }
	| { type: 'group'; id: string; label: string; parts: ToolActivityPart[] };

const webOperationCategories = {
	search_query: 'search',
	image_query: 'image-search',
	find: 'find',
	click: 'link',
	screenshot: 'pdf',
	open: 'page',
} as const;
const webResultHasIncompleteOperations = new WeakMap<
	NonNullable<ToolCallRecord['result']>,
	boolean
>();

/** Native web.run can return a successful tool result containing failed individual operations. */
function incompleteWebOperations(result: ToolCallRecord['result']): boolean {
	if (!result) return false;
	const cached = webResultHasIncompleteOperations.get(result);
	if (cached !== undefined) return cached;
	let incomplete = false;
	for (const part of result.content) {
		if (part.type !== 'text') continue;
		try {
			const envelope: unknown = JSON.parse(part.text);
			if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
			const value = envelope as Record<string, unknown>;
			if (
				(typeof value.omitted_operations === 'number' && value.omitted_operations > 0) ||
				(Array.isArray(value.unresponsive_engines) && value.unresponsive_engines.length > 0) ||
				(Array.isArray(value.results) &&
					value.results.some(
						(operation) =>
							operation &&
							typeof operation === 'object' &&
							!Array.isArray(operation) &&
							(!!operation.error ||
								(Array.isArray(operation.unresponsive_engines) &&
									operation.unresponsive_engines.length > 0)),
					))
			) {
				incomplete = true;
				break;
			}
		} catch {
			// Legacy results can contain plain text instead of the native JSON envelope.
		}
	}
	webResultHasIncompleteOperations.set(result, incomplete);
	return incomplete;
}

function historyCategory(
	call: ToolCallRecord,
	labels: ReadonlyMap<string, string>,
	sessions: ReadonlyMap<string, CommandActivity>,
): string | undefined {
	// Errors and pending approvals stay visible. Yielded commands may group, but
	// their aggregate must retain the running state rather than claim success.
	if (call.status !== 'completed' || call.result?.isError) return;
	if (call.name === 'view_image' || call.name === 'image.view') return 'image';
	if (isFileEditingCall(call)) return 'edit';
	if (call.name === 'exec_command' || call.name === 'write_stdin') {
		const process = commandActivity(call);
		const session = sessions.get(commandSessionId(call, process));
		const exit = session?.exitCode !== undefined ? session.exitCode : process?.exitCode;
		if ((typeof exit === 'number' && exit !== 0) || exit === null) return;
		return /^(Ran|Running) /.test(labels.get(call.id) || '') ? 'command' : undefined;
	}
	// Assistant updates, questions and generated assets retain their independent presentation.
	if (
		call.name === 'send_message_to_user_async' ||
		call.name === 'request_user_input' ||
		call.name === 'image_gen.imagegen' ||
		call.name === 'video_gen.videogen'
	)
		return;
	if (call.name !== 'web.run') return `tool:${call.name}`;
	if (incompleteWebOperations(call.result)) return;
	const args = toolArguments(call);
	const operations = (
		Object.keys(webOperationCategories) as (keyof typeof webOperationCategories)[]
	).filter(
		(operation) => Array.isArray(args[operation]) && (args[operation] as unknown[]).length > 0,
	);
	// A mixed batch has no single truthful category/count, even when every operation succeeds.
	if (operations.length === 1) return webOperationCategories[operations[0]];
}

function historyGroupLabel(
	category: string,
	calls: readonly ToolCallRecord[],
	labels: ReadonlyMap<string, string>,
): string {
	let count = calls.length;
	if (category === 'command') {
		// A process may yield several times. Its polls are details of one execution.
		count = new Set(calls.map((call) => commandSessionId(call) || `call:${call.id}`)).size;
	} else {
		const operation = (
			Object.keys(webOperationCategories) as (keyof typeof webOperationCategories)[]
		).find((key) => webOperationCategories[key] === category);
		if (operation)
			count = calls.reduce((sum, call) => {
				const value = toolArguments(call)[operation];
				return sum + (Array.isArray(value) ? value.length : 0);
			}, 0);
	}
	switch (category) {
		case 'image':
			return `Viewed ${count} images`;
		case 'edit': {
			const files = editedFileActivityCount(calls);
			return files === undefined
				? 'Edited files'
				: `Edited ${files} ${files === 1 ? 'file' : 'files'}`;
		}
		case 'command':
			return `${calls.some((call) => labels.get(call.id)?.startsWith('Running ')) ? 'Running' : 'Ran'} ${count} ${count === 1 ? 'command' : 'commands'}`;
		case 'search':
			return `Searched the web ${count} times`;
		case 'image-search':
			return `Searched for images ${count} times`;
		case 'find':
			return `Searched page text ${count} times`;
		case 'link':
			return `Followed ${count} web links`;
		case 'pdf':
			return `Viewed PDF pages ${count} times`;
		case 'page':
			return `Read web pages ${count} times`;
		default:
			// Unrecognized integrations still collapse only with the exact same tool.
			return `${toolActivityLabel({ ...calls[0], arguments: '{}' })} ${count} times`;
	}
}

/** Group adjacent operations; text, errors and other tool kinds preserve boundaries. */
export function groupActivityHistory(
	parts: readonly ChatActivityPart[],
	callsById: ReadonlyMap<string, ToolCallRecord>,
	labels: ReadonlyMap<string, string>,
): ActivityHistoryEntry[] {
	const entries: ActivityHistoryEntry[] = [];
	const sessions = commandSessions([...callsById.values()]);
	const groupCategories = new Map<string, string>();
	let previousCategory: string | undefined;
	for (const part of parts) {
		const call = part.type === 'tool' ? callsById.get(part.toolCallId) : undefined;
		const category = call ? historyCategory(call, labels, sessions) : undefined;
		const previous = entries[entries.length - 1];
		if (category && category === previousCategory && part.type === 'tool' && previous) {
			if (previous.type === 'group') {
				previous.parts.push(part);
			} else if (previous.part.type === 'tool') {
				groupCategories.set(previous.part.id, category);
				entries[entries.length - 1] = {
					type: 'group',
					id: previous.part.id,
					parts: [previous.part, part],
					label: '',
				};
			}
		} else entries.push({ type: 'part', part });
		previousCategory = category;
	}
	// Resolve each aggregate once; appending another tool must not recount every prefix.
	for (const entry of entries) {
		if (entry.type !== 'group') continue;
		entry.label = historyGroupLabel(
			groupCategories.get(entry.id)!,
			entry.parts.map((item) => callsById.get(item.toolCallId)!),
			labels,
		);
	}
	return entries;
}

/** A single label replaces the previous tool rather than accumulating statuses. */
export function activeToolCall(message: Message): ToolCallRecord | undefined {
	const calls = message.toolCalls || [];
	for (let index = calls.length - 1; index >= 0; index--)
		if (calls[index].status === 'running' || calls[index].status === 'approval')
			return calls[index];
	return undefined;
}

export function formatActivityDuration(milliseconds: number): string {
	const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function activityDuration(
	message: Message & { activityStartedAt?: number; activityFinishedAt?: number },
): number {
	const startedAt = message.activityStartedAt ?? message.createdAt;
	const finishedAt = message.activityFinishedAt ?? message.completedAt;
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
	return Math.max(0, finishedAt! - startedAt);
}
