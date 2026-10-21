import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PromptContextSection, ToolResult } from '../../src/agent-types';
import type { Message, Thread } from '../../src/types';
import {
	CODE_KNOWLEDGE_INSTRUCTIONS,
	codeKnowledgeTools,
	isCodeKnowledgeTool,
} from '../../src/lib/code-knowledge-tools';
import { safePath, textResult } from './common';

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_DOCUMENTS = 256;
const MAX_OUTPUT_CHARS = 32000;
const MAX_HISTORY_ITEMS = 50000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface CodeKnowledgeContext {
	threadId: string;
	projectId?: string;
	/** Actual project directories derived by the host, never arguments chosen by the model. */
	workspaceRoots?: string[];
	loadHistory: () => Promise<Thread>;
}
interface Document {
	path: string;
	content: string;
	revision: string;
	bytes: number;
	updatedAt: number;
}
interface HistoryItem {
	id: string;
	window_id: string;
	message_id: string;
	role: string;
	kind: 'message' | 'transcript' | 'tool';
	createdAt: number;
	inactive: boolean;
	tool_name?: string;
	value: unknown;
}
interface HistoryWindow {
	window_id: string;
	item_count: number;
	createdAt: number;
	inactive: boolean;
	kind?: 'compaction' | 'reset';
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
		throw new Error(`Expected an integer between ${min} and ${max}.`);
	return value as number;
}
function identifier(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
		throw new Error(`${label} must be a nonempty ID of at most 256 characters.`);
	return value;
}
function relativeDocument(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length > 160 ||
		!/\.md$/i.test(value) ||
		value.includes('\\')
	)
		throw new Error('Use a relative Markdown document path of at most 160 characters.');
	const parts = value.split('/');
	if (
		parts.length > 4 ||
		parts.some(
			(part) =>
				!part ||
				part === '..' ||
				part === '.' ||
				part.startsWith('.') ||
				!/^[a-zA-Z0-9 _.-]+$/.test(part),
		)
	)
		throw new Error('Document paths cannot contain hidden, empty, or parent-directory components.');
	return value;
}
function documentText(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > 65536 ||
		value.includes('\0') ||
		Buffer.byteLength(value) > MAX_DOCUMENT_BYTES
	)
		throw new Error(
			'Document text must contain 1–65536 characters and at most 128 KiB of UTF-8 text.',
		);
	return value;
}
function queryWords(value: unknown): string[] {
	if (typeof value !== 'string' || !value.trim() || value.length > 2000)
		throw new Error('Search query must contain 1–2000 characters.');
	return value.trim().toLocaleLowerCase().split(/\s+/u);
}
function pagination(args: Record<string, unknown>) {
	return {
		offset: boundedInteger(args.offset, 0, 0, 50000),
		limit: boundedInteger(args.limit, 20, 1, 50),
	};
}
function page<T>(values: T[], args: Record<string, unknown>, key: string) {
	const { offset, limit } = pagination(args);
	return {
		[key]: values.slice(offset, offset + limit),
		total: values.length,
		offset,
		...(offset + limit < values.length ? { next_offset: offset + limit } : {}),
	};
}
function abort(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('Code knowledge operation was cancelled.');
}

/** Recover text/JSON without replaying binary assets or mutating the stored transcript. */
function historyText(value: unknown): string {
	if (typeof value === 'string')
		return value.replace(/data:[^\s"<>]*;base64,[A-Za-z0-9+/=]+/g, '[binary asset omitted]');
	let nodes = 0;
	const clean = (input: unknown, depth: number): unknown => {
		if (++nodes > 20000 || depth > 20) return '[structure omitted]';
		if (typeof input === 'string') {
			if (/^data:.*;base64,/s.test(input)) return '[binary asset omitted]';
			return input;
		}
		if (Array.isArray(input)) return input.map((item) => clean(item, depth + 1));
		if (input && typeof input === 'object')
			return Object.fromEntries(
				Object.entries(input).map(([key, item]) => [
					key,
					/^(?:b64_json|base64|dataUrl)$/i.test(key)
						? '[binary asset omitted]'
						: clean(item, depth + 1),
				]),
			);
		return input;
	};
	return JSON.stringify(clean(value, 0), null, 2) ?? '';
}

export class CodeKnowledgeRuntime {
	readonly tools = codeKnowledgeTools;
	private root: string;
	private queues = new Map<string, Promise<unknown>>();

	/** rootDir is FreeLM's host profile root (or an isolated test root), not a project. */
	constructor(rootDir: string) {
		if (!path.isAbsolute(rootDir))
			throw new Error('Code knowledge requires an absolute profile root.');
		this.root = path.resolve(rootDir);
	}
	private scope(context: CodeKnowledgeContext): string {
		identifier(context.threadId, 'Thread');
		return context.projectId === undefined
			? 'workspace'
			: `project-${hash(identifier(context.projectId, 'Project')).slice(0, 32)}`;
	}
	private directory(context: CodeKnowledgeContext, memory: boolean): string {
		const scope = this.scope(context);
		return memory
			? path.join(this.root, 'code', 'memories', scope)
			: path.join(this.root, 'code', 'tasks', hash(context.threadId).slice(0, 32), 'notes');
	}
	private async checkedPath(target: string): Promise<string> {
		// Reject symlinked profile roots and every descendant. Parent aliases such as macOS /tmp
		// are host-selected, and are resolved once without granting access through model paths.
		try {
			const info = await lstat(this.root);
			if (info.isSymbolicLink() || !info.isDirectory())
				throw new Error('Code knowledge profile root must be a directory, not a symbolic link.');
		} catch (error) {
			if (!missing(error)) throw error;
		}
		return safePath(this.root, target, true);
	}
	private async ensureDirectory(directory: string): Promise<void> {
		await this.checkedPath(directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await this.checkedPath(directory);
	}
	private async readDocument(directory: string, relative: string): Promise<Document | undefined> {
		const file = await this.checkedPath(path.join(directory, relativeDocument(relative)));
		let handle;
		try {
			handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES)
				throw new Error('Knowledge documents must be regular files of at most 128 KiB.');
			const buffer = Buffer.alloc(Math.min(MAX_DOCUMENT_BYTES + 1, info.size + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_DOCUMENT_BYTES) throw new Error('Knowledge document exceeds 128 KiB.');
			const content = new TextDecoder('utf-8', { fatal: true }).decode(
				buffer.subarray(0, bytesRead),
			);
			if (content.includes('\0')) throw new Error('Knowledge document must be UTF-8 text.');
			return {
				path: relative,
				content,
				revision: hash(content),
				bytes: bytesRead,
				updatedAt: info.mtimeMs,
			};
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		} finally {
			await handle?.close();
		}
	}
	private async documents(directory: string, signal?: AbortSignal): Promise<Document[]> {
		await this.checkedPath(directory);
		const documents: Document[] = [];
		const visit = async (current: string, depth: number) => {
			abort(signal);
			let entries;
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch (error) {
				if (missing(error)) return;
				throw error;
			}
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				abort(signal);
				if (entry.name.startsWith('.')) continue;
				if (entry.isSymbolicLink())
					throw new Error('Symbolic links are not allowed in Code knowledge stores.');
				const file = path.join(current, entry.name);
				if (entry.isDirectory() && depth < 3) await visit(file, depth + 1);
				if (entry.isFile() && /\.md$/i.test(entry.name)) {
					if (documents.length >= MAX_DOCUMENTS)
						throw new Error('This knowledge store exceeds the 256-document limit.');
					const item = await this.readDocument(
						directory,
						path.relative(directory, file).split(path.sep).join('/'),
					);
					if (item) documents.push(item);
				}
			}
		};
		await visit(directory, 0);
		return documents;
	}
	private async atomicWrite(
		directory: string,
		relative: string,
		content: string,
	): Promise<Document> {
		if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES)
			throw new Error('Knowledge document exceeds 128 KiB; split it into separate notes.');
		const destination = await this.checkedPath(path.join(directory, relativeDocument(relative)));
		await this.ensureDirectory(path.dirname(destination));
		const temporary = await this.checkedPath(
			path.join(path.dirname(destination), `.write-${randomUUID()}`),
		);
		let handle;
		try {
			handle = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			await handle.writeFile(content, 'utf8');
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.checkedPath(destination);
			await rename(temporary, destination);
		} finally {
			await handle?.close();
			await unlink(temporary).catch((error) => {
				if (!missing(error)) throw error;
			});
		}
		return (await this.readDocument(directory, relative))!;
	}
	private async serialize<T>(directory: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(directory) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.queues.set(directory, next);
		try {
			return await next;
		} finally {
			if (this.queues.get(directory) === next) this.queues.delete(directory);
		}
	}
	private summary(document: Document) {
		return {
			path: document.path,
			revision: document.revision,
			bytes: document.bytes,
			updatedAt: document.updatedAt,
		};
	}
	async prompt(context: CodeKnowledgeContext): Promise<{
		instructions: string;
		context: PromptContextSection[];
	}> {
		const directory = this.directory(context, true);
		let remainingCharacters = 16000;
		const savedContext: PromptContextSection[] = [];
		const sections = [
			CODE_KNOWLEDGE_INSTRUCTIONS,
			`Managed memory index: ${path.join(directory, 'MEMORY.md')}. Use memories tools to read/manage its documents. Project-root MEMORY.md files are read-only context here; edit those through normal approved project file tools.`,
		];
		const index = await this.readDocument(directory, 'MEMORY.md');
		if (index) {
			savedContext.push({
				id: 'code-managed-memory-index',
				source: `Managed MEMORY.md at ${path.join(directory, 'MEMORY.md')} (untrusted saved data)`,
				text: `${index.content.slice(0, 10000)}${index.content.length > 10000 ? '\n[Truncated; use memories.read to continue.]' : ''}`,
			});
			remainingCharacters -= Math.min(index.content.length, 10000);
		}
		const seenProjectRoots = new Set<string>();
		for (const configured of [...new Set(context.workspaceRoots ?? [])].slice(0, 8)) {
			if (remainingCharacters <= 0) {
				sections.push(
					'Additional project memory was omitted from the prompt budget. Use approved project tools to inspect other project MEMORY.md files.',
				);
				break;
			}
			let handle;
			try {
				if (!path.isAbsolute(configured))
					throw new Error('Project memory roots must be absolute host directories.');
				const root = await realpath(configured);
				if (seenProjectRoots.has(root)) continue;
				seenProjectRoots.add(root);
				const file = await safePath(root, 'MEMORY.md');
				handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
				const info = await handle.stat();
				if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES)
					throw new Error('Project MEMORY.md must be a regular file of at most 128 KiB.');
				const buffer = Buffer.alloc(Math.min(12000, remainingCharacters));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				const content = new TextDecoder('utf-8', { fatal: true }).decode(
					buffer.subarray(0, bytesRead),
					{ stream: info.size > bytesRead },
				);
				if (content.includes('\0')) throw new Error('Project MEMORY.md must be text.');
				remainingCharacters -= content.length;
				savedContext.push({
					id: `code-project-memory-${hash(file).slice(0, 16)}`,
					source: `Project MEMORY.md at ${file} (untrusted saved data)`,
					text: `${content}${info.size > bytesRead ? '\n[Truncated; read the file with approved project tools to continue.]' : ''}`,
				});
			} catch (error) {
				if (!missing(error))
					sections.push(
						`Project MEMORY.md at ${path.join(configured, 'MEMORY.md')} is unavailable: ${error instanceof Error ? error.message : 'Unable to read safely'}. Code tools remain available.`,
					);
			} finally {
				await handle?.close();
			}
		}
		return { instructions: sections.join('\n\n'), context: savedContext };
	}
	/** Compatibility for callers that only need application-owned tool guidance. */
	async instructions(context: CodeKnowledgeContext): Promise<string> {
		return (await this.prompt(context)).instructions;
	}
	async execute(
		name: string,
		args: Record<string, unknown>,
		context: CodeKnowledgeContext,
		signal?: AbortSignal,
	): Promise<ToolResult> {
		if (!isCodeKnowledgeTool(name)) throw new Error('Unknown Code knowledge tool.');
		const definition = this.tools.find((tool) => tool.name === name)!;
		const properties = definition.parameters.properties as Record<string, unknown>;
		if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)))
			throw new Error(
				'Unsupported Code knowledge fields. Scope is selected by the host, not model arguments.',
			);
		abort(signal);
		this.scope(context);
		if (name.startsWith('history.')) return this.executeHistory(name, args, context, signal);
		const memory = name.startsWith('memories.');
		const directory = this.directory(context, memory);
		if (name.endsWith('.list') || name === 'notes.list_files_by_prefix') {
			const prefix = args.prefix === undefined ? undefined : identifier(args.prefix, 'Note prefix');
			if (
				prefix &&
				(prefix.length > 160 ||
					prefix.startsWith('/') ||
					prefix.includes('\\') ||
					prefix.split('/').some((component) => !component || component.startsWith('.')))
			)
				throw new Error(
					'Use a relative note prefix without hidden or parent-directory components.',
				);
			return textResult(
				page(
					(await this.documents(directory, signal))
						.filter((document) => !prefix || document.path.startsWith(prefix))
						.map((document) => this.summary(document)),
					args,
					'documents',
				),
			);
		}
		if (name.endsWith('.read') || name === 'notes.read_file') {
			const document = await this.readDocument(directory, relativeDocument(args.path));
			if (!document) throw new Error('Document not found in the current Code scope.');
			const lines = document.content.split('\n');
			const start = boundedInteger(args.start_line, 1, 1, 100000);
			const count = boundedInteger(args.line_count, 200, 1, 500);
			const selected = lines.slice(start - 1, start - 1 + count).join('\n');
			const characterOffset = boundedInteger(args.character_offset, 0, 0, MAX_DOCUMENT_BYTES);
			return textResult({
				...this.summary(document),
				start_line: start,
				total_lines: lines.length,
				character_offset: characterOffset,
				content: selected.slice(characterOffset, characterOffset + MAX_OUTPUT_CHARS),
				truncated:
					characterOffset + MAX_OUTPUT_CHARS < selected.length || start - 1 + count < lines.length,
				...(characterOffset + MAX_OUTPUT_CHARS < selected.length
					? { next_character_offset: characterOffset + MAX_OUTPUT_CHARS }
					: start - 1 + count < lines.length
						? { next_line: start + count }
						: {}),
			});
		}
		if (name.endsWith('.search') || name === 'notes.search_contents') {
			const words = queryWords(args.query);
			const matches = [];
			for (const document of await this.documents(directory, signal)) {
				abort(signal);
				for (const [index, line] of document.content.split('\n').entries()) {
					if (words.every((word) => line.toLocaleLowerCase().includes(word)))
						matches.push({
							...this.summary(document),
							line: index + 1,
							content: line.slice(0, 600),
						});
				}
			}
			return textResult(page(matches, args, 'matches'));
		}
		return this.serialize(directory, async () => {
			abort(signal);
			if (name === 'memories.add_ad_hoc_note') {
				const text = documentText(args.content);
				const title =
					args.title === undefined
						? text.trim().split('\n')[0].slice(0, 100)
						: identifier(args.title, 'Title');
				if (title.length > 160) throw new Error('Memory title must be at most 160 characters.');
				const existing = await this.documents(directory, signal);
				const duplicate = existing.find(
					(document) => document.path !== 'MEMORY.md' && document.content.trim() === text.trim(),
				);
				if (duplicate) return textResult({ document: this.summary(duplicate), duplicate: true });
				if (existing.length >= MAX_DOCUMENTS - 1)
					throw new Error(
						'At most 256 memory documents are supported; update or delete existing notes.',
					);
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				const slug =
					title
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/^-|-$/g, '')
						.slice(0, 50) || 'note';
				const relative = `notes/${timestamp}-${slug}-${randomUUID().slice(0, 8)}.md`;
				const index = await this.readDocument(directory, 'MEMORY.md');
				const safeTitle = title.replace(/[\[\]\r\n]/g, ' ');
				const link = `- [${safeTitle}](${relative})\n`;
				const indexText = `${index?.content ?? '# Code memory\n\n'}${index?.content && !index.content.endsWith('\n') ? '\n' : ''}${link}`;
				if (Buffer.byteLength(indexText) > MAX_DOCUMENT_BYTES)
					throw new Error('MEMORY.md is full. Condense the index before adding another memory.');
				const note = await this.atomicWrite(directory, relative, text);
				try {
					await this.atomicWrite(directory, 'MEMORY.md', indexText);
				} catch (error) {
					await unlink(await this.checkedPath(path.join(directory, relative)));
					throw error;
				}
				return textResult({ document: this.summary(note), index: 'MEMORY.md' });
			}
			const relative = relativeDocument(args.path);
			const previous = await this.readDocument(directory, relative);
			if (name.endsWith('.delete')) {
				if (memory && relative === 'MEMORY.md')
					throw new Error('Update MEMORY.md rather than deleting the memory index.');
				if (!previous) throw new Error('Document not found in this Code scope.');
				if (args.revision !== previous.revision)
					throw new Error('Document changed. Read its latest revision before deleting.');
				if (memory) {
					const index = await this.readDocument(directory, 'MEMORY.md');
					if (index)
						await this.atomicWrite(
							directory,
							'MEMORY.md',
							index.content
								.split('\n')
								.filter((line) => !line.includes(`](${relative})`))
								.join('\n'),
						);
				}
				abort(signal);
				await unlink(await this.checkedPath(path.join(directory, relative)));
				return textResult({ deleted: relative });
			}
			const text = documentText(memory ? args.content : args.text);
			const append = name === 'notes.append_to_file';
			if (!append && previous && args.revision !== previous.revision)
				throw new Error('Document changed. Read its latest revision before replacing.');
			if (!previous && args.revision !== undefined)
				throw new Error('Document no longer exists. Omit revision to create a new document.');
			if (memory && !previous && relative !== 'MEMORY.md')
				throw new Error('Create memory notes with memories.add_ad_hoc_note.');
			if (!previous && (await this.documents(directory, signal)).length >= MAX_DOCUMENTS)
				throw new Error('At most 256 knowledge documents are supported.');
			abort(signal);
			return textResult({
				document: this.summary(
					await this.atomicWrite(
						directory,
						relative,
						append ? `${previous?.content ?? ''}${text}` : text,
					),
				),
			});
		});
	}

	private async history(
		context: CodeKnowledgeContext,
		signal?: AbortSignal,
	): Promise<{ items: HistoryItem[]; windows: HistoryWindow[]; truncated: boolean }> {
		const thread = await context.loadHistory();
		if (
			thread.id !== context.threadId ||
			thread.projectId !== context.projectId ||
			thread.kind === 'chat'
		)
			throw new Error('Code task history scope changed.');
		const active = new Set(thread.messages.map((message) => message.id));
		const unique = new Map<string, Message>();
		for (const message of thread.messageHistory ?? []) unique.set(message.id, message);
		for (const message of thread.messages) unique.set(message.id, message);
		const messages = [...unique.values()].sort((a, b) => a.createdAt - b.createdAt);
		const checkpoints = messages
			.filter((message) => active.has(message.id))
			.flatMap((message) => {
				const transcript = message.agentTranscript;
				if (transcript?.contextWindows?.length)
					return transcript.contextWindows.map((window) => ({ message, checkpoint: window }));
				const legacy = transcript?.context;
				return legacy
					? [
							{
								message,
								checkpoint: {
									id: `before-${hash(message.id).slice(0, 20)}`,
									transcriptItemCount: legacy.transcriptItemCount,
									historyMessageIds: legacy.historyMessageIds,
									createdAt: legacy.createdAt,
									kind: 'compaction' as const,
								},
							},
						]
					: [];
			})
			.sort((a, b) => a.checkpoint.createdAt - b.checkpoint.createdAt);
		const messageWindows = new Map<string, { order: number; id: string }>();
		const ownerWindows = new Map<string, { order: number; id: string; count: number }[]>();
		const windows = new Map<string, HistoryWindow>();
		for (const [order, { message, checkpoint }] of checkpoints.entries()) {
			abort(signal);
			const id = checkpoint.id;
			const owned = ownerWindows.get(message.id) ?? [];
			owned.push({ order, id, count: checkpoint.transcriptItemCount });
			ownerWindows.set(message.id, owned);
			windows.set(id, {
				window_id: id,
				item_count: 0,
				createdAt: checkpoint.createdAt,
				inactive: false,
				kind: checkpoint.kind,
			});
			for (const messageId of checkpoint.historyMessageIds) {
				if (!messageWindows.has(messageId)) messageWindows.set(messageId, { order, id });
			}
		}
		const windowFor = (message: Message, transcriptIndex?: number) => {
			if (!active.has(message.id)) return 'inactive';
			const prior = messageWindows.get(message.id);
			const own =
				transcriptIndex === undefined
					? undefined
					: ownerWindows.get(message.id)?.find((window) => transcriptIndex < window.count);
			if (
				own &&
				transcriptIndex !== undefined &&
				transcriptIndex < own.count &&
				(!prior || own.order < prior.order)
			)
				return own.id;
			return prior?.id ?? 'current';
		};
		const items: HistoryItem[] = [];
		const messageIds = new Map(
			messages.map((message) => [message.id, hash(message.id).slice(0, 20)]),
		);
		const add = (
			message: Message,
			suffix: string,
			kind: HistoryItem['kind'],
			value: unknown,
			role: string,
			transcriptIndex?: number,
			toolName?: string,
		) => {
			if (items.length >= MAX_HISTORY_ITEMS) return;
			items.push({
				id: `${messageIds.get(message.id)}-${suffix}`,
				window_id: windowFor(message, transcriptIndex),
				message_id: message.id,
				role,
				kind,
				createdAt: message.createdAt,
				inactive: !active.has(message.id),
				...(toolName ? { tool_name: toolName } : {}),
				value,
			});
		};
		let total = 0;
		for (const [ordinal, message] of messages.entries()) {
			if (ordinal % 100 === 0) {
				abort(signal);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			total++;
			add(message, 'message', 'message', message.content, message.role);
			for (const [index, item] of (message.agentTranscript?.items ?? []).entries()) {
				total++;
				const role =
					typeof item.role === 'string'
						? item.role
						: item.type === 'function_call_output'
							? 'tool'
							: 'assistant';
				add(
					message,
					`transcript-${index}`,
					'transcript',
					item,
					role,
					index,
					typeof item.name === 'string' ? item.name : undefined,
				);
			}
			// UI-owned tool records include exact arguments/results even for legacy messages
			// that predate protocol transcripts and for denied/failed calls.
			for (const call of message.toolCalls ?? []) {
				total++;
				add(
					message,
					`tool-${hash(call.id).slice(0, 16)}`,
					'tool',
					{ name: call.name, arguments: call.arguments, status: call.status, result: call.result },
					'tool',
					undefined,
					call.name,
				);
			}
		}
		for (const item of items) {
			const existing = windows.get(item.window_id);
			if (existing) existing.item_count++;
			else
				windows.set(item.window_id, {
					window_id: item.window_id,
					item_count: 1,
					createdAt: item.createdAt,
					inactive: item.inactive,
				});
		}
		return { items, windows: [...windows.values()], truncated: total > items.length };
	}
	private async executeHistory(
		name: string,
		args: Record<string, unknown>,
		context: CodeKnowledgeContext,
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const history = await this.history(context, signal);
		abort(signal);
		const metadata = ({ value: _value, ...item }: HistoryItem) => item;
		if (name === 'history.list_windows') {
			return textResult({
				...page(history.windows, args, 'windows'),
				truncated: history.truncated,
			});
		}
		if (name === 'history.read_item') {
			const item = history.items.find(
				(item) => item.id === identifier(args.item_id, 'History item'),
			);
			if (!item) throw new Error('History item not found in the current Code task.');
			const content = historyText(item.value);
			const offset = boundedInteger(args.character_offset, 0, 0, 20000000);
			const limit = boundedInteger(args.character_limit, 12000, 1, MAX_OUTPUT_CHARS);
			return textResult({
				...metadata(item),
				content: content.slice(offset, offset + limit),
				character_offset: offset,
				total_characters: content.length,
				truncated: offset + limit < content.length,
				...(offset + limit < content.length ? { next_character_offset: offset + limit } : {}),
			});
		}
		const windowId =
			args.window_id === undefined ? undefined : identifier(args.window_id, 'History window');
		const selected = history.items.filter((item) => !windowId || item.window_id === windowId);
		if (name === 'history.list_items') {
			const { offset, limit } = pagination(args);
			return textResult({
				...page(selected.map(metadata), args, 'items'),
				items: selected
					.slice(offset, offset + limit)
					.map((item) => ({ ...metadata(item), excerpt: historyText(item.value).slice(0, 500) })),
				truncated: history.truncated,
			});
		}
		const words = queryWords(args.query);
		const matches = [];
		for (const [index, item] of selected.entries()) {
			if (index % 50 === 0) {
				abort(signal);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const content = historyText(item.value);
			const normalized = content.toLocaleLowerCase();
			if (words.every((word) => normalized.includes(word))) {
				const start = Math.max(0, normalized.indexOf(words[0]) - 100);
				matches.push({
					...metadata(item),
					excerpt: content.slice(start, start + 600),
					character_offset: start,
				});
			}
		}
		return textResult({ ...page(matches, args, 'matches'), truncated: history.truncated });
	}
}
