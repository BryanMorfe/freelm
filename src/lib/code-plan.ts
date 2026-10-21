import type { ComposerContext, ComposerMode } from '../composer-types';

type ComposerMessage = { role: string; composer?: ComposerContext };
type ComposerHistory = readonly ComposerMessage[] | { messages?: readonly ComposerMessage[] };

/** Only committed human input selects a mode; drafts and assistant/tool text do not. */
export function latestComposerMode(history?: ComposerHistory): ComposerMode | undefined {
	const messages =
		history &&
		(Array.isArray(history)
			? history
			: (history as { messages?: readonly ComposerMessage[] }).messages);
	if (!messages) return;
	for (let index = messages.length - 1; index >= 0; index--)
		if (messages[index].role === 'user') return messages[index].composer?.mode;
}

// Adapted from the pinned Codex collaboration-mode plan workflow. The host also
// enforces admission; these model instructions alone never grant tool authority.
export const CODE_PLAN_INSTRUCTIONS = `Code Plan mode is active for this request. Explore the actual workspace, clarify important decisions, and prepare an implementable plan. Do not implement the plan or change files, install packages, run migrations, generate media, or modify tasks or saved knowledge. A request to implement while the Plan mode selection remains active means plan that implementation. Only the user changing the composer mode ends Plan mode.

Start with targeted read-only exploration when a workspace is available. Resolve discoverable facts from the repository before asking the user. Ask concise questions with request_user_input only for important missing preferences, constraints, or decisions that inspection cannot resolve. Continue refining until the intended behavior, approach, interfaces, important failure cases, and acceptance checks are clear. update_plan may display a planning checklist; it does not change modes or authorize implementation.

The execution host permits a bounded set of literal read commands, file inspection, search, history/memory reads, skill reads and isolated tool orchestration. Ambiguous scripts, custom shells, external MCP actions, arbitrary process input, and writes are blocked even with Full access. A denial is not a request to bypass Plan mode: use a permitted read tool or explain the limitation.

When the plan is ready, return one complete Markdown plan inside <proposed_plan> and </proposed_plan>, with each tag on its own line. Include a title, a concise summary, implementation changes, validation, and material assumptions. A revised plan replaces the previous plan completely. Do not request permission to proceed; FreeLM provides an Implement plan action that explicitly switches modes.`;

export function codePlanInstructions(history?: ComposerHistory): string {
	return latestComposerMode(history) === 'plan' ? CODE_PLAN_INSTRUCTIONS : '';
}

export interface CodePlanCommand {
	words: string[];
	/** Join this command to the following command. */
	separator?: '|' | '&&' | '||' | ';';
}

/**
 * Parse a deliberately small literal-shell subset. Expansion, redirection,
 * substitution, background jobs, comments and shell programs are not admitted.
 * The host reconstructs these words with shell quoting and absolute executables.
 */
export function parseCodePlanCommand(command: string): CodePlanCommand[] | undefined {
	if (!command.trim() || command.length > 100_000 || command.includes('\0')) return;
	const commands: CodePlanCommand[] = [];
	let words: string[] = [],
		word = '',
		started = false;
	let quote: "'" | '"' | undefined;
	const finishWord = () => {
		if (started) words.push(word);
		word = '';
		started = false;
	};
	const finishCommand = (separator?: CodePlanCommand['separator']) => {
		finishWord();
		if (!words.length || words.length > 1000 || commands.length >= 32) return false;
		commands.push({ words, ...(separator ? { separator } : {}) });
		words = [];
		return true;
	};
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (quote) {
			if (character === quote) quote = undefined;
			else if (quote === '"' && ['$', '`'].includes(character)) return;
			else if (quote === '"' && character === '\\') {
				const next = command[++index];
				if (next === undefined || next === '\n' || next === '\r') return;
				word += ['"', '\\', '$', '`'].includes(next) ? next : `\\${next}`;
			} else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
		} else if (character === '\\') {
			const next = command[++index];
			if (next === undefined || next === '\n' || next === '\r') return;
			word += next;
			started = true;
		} else if (character === '\n' || character === ';' || character === '|' || character === '&') {
			let separator: CodePlanCommand['separator'];
			if (character === '\n' || character === ';') separator = ';';
			else if (command[index + 1] === character) {
				separator = character === '|' ? '||' : '&&';
				index++;
			} else if (character === '|') separator = '|';
			else return;
			if (!finishCommand(separator)) return;
		} else if (/\s/.test(character)) finishWord();
		else if (/[<>$`(){}*?\[\]~#]/.test(character)) return;
		else {
			word += character;
			started = true;
		}
	}
	if (quote) return;
	if (started || words.length) {
		if (!finishCommand()) return;
	} else if (commands.length && commands.at(-1)?.separator === ';')
		delete commands.at(-1)!.separator;
	else return;
	return commands.every(({ words }) => isCodePlanReadCommand(words)) ? commands : undefined;
}

const literalReadCommands = new Set([
	'pwd',
	'ls',
	'cat',
	'head',
	'tail',
	'wc',
	'grep',
	'stat',
	'du',
	'readlink',
	'realpath',
	'basename',
	'dirname',
	'echo',
	'printf',
	'cut',
	'jq',
]);
const executableDirectories = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']);
export const CODE_PLAN_EXECUTABLE_DIRECTORIES = [...executableDirectories];

export function codePlanExecutableName(executable: string): string | undefined {
	if (!executable.includes('/')) return executable;
	const split = executable.lastIndexOf('/');
	return executableDirectories.has(executable.slice(0, split))
		? executable.slice(split + 1)
		: undefined;
}

function isCodePlanReadCommand(words: string[]): boolean {
	const name = codePlanExecutableName(words[0]);
	if (!name) return false;
	const args = words.slice(1);
	if (literalReadCommands.has(name)) return true;
	if (name === 'rg')
		return !args.some((arg) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg));
	if (name === 'file') return !args.some((arg) => /^--compile(?:=|$)|^-[^-]*C/.test(arg));
	if (name === 'sort')
		return !args.some((arg) =>
			/^--(?:output|compress-program|temporary-directory)(?:=|$)|^-[^-]*[oT]/.test(arg),
		);
	if (name === 'date')
		return args.every(
			(arg) => arg.startsWith('+') || ['-u', '--utc', '-R', '-I', '--iso-8601'].includes(arg),
		);
	if (name === 'find') {
		const flags = new Set([
			'-H',
			'-L',
			'-P',
			'-maxdepth',
			'-mindepth',
			'-depth',
			'-xdev',
			'-mount',
			'-name',
			'-iname',
			'-path',
			'-ipath',
			'-type',
			'-size',
			'-empty',
			'-mtime',
			'-mmin',
			'-atime',
			'-amin',
			'-ctime',
			'-cmin',
			'-newer',
			'-perm',
			'-user',
			'-group',
			'-uid',
			'-gid',
			'-links',
			'-print',
			'-print0',
			'-printf',
			'-prune',
			'-true',
			'-false',
			'-a',
			'-and',
			'-o',
			'-or',
			'-not',
			'-quit',
		]);
		return args.every((arg) => !arg.startsWith('-') || flags.has(arg));
	}
	if (name === 'sed') {
		if (args[0] !== '-n') return false;
		const scriptIndex = args[1] === '-e' ? 2 : 1;
		const script = args[scriptIndex] ?? '';
		return (
			/^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|\/[^/\\\r\n]+\/)?p$/.test(script) &&
			args.slice(scriptIndex + 1).every((arg) => !arg.startsWith('-'))
		);
	}
	if (name === 'git') return isCodePlanGitRead(args);
	return false;
}

function isCodePlanGitRead(input: string[]): boolean {
	const args = [...input];
	while (args[0] === '-C' && args[1]) args.splice(0, 2);
	while (['--no-pager', '--no-optional-locks'].includes(args[0])) args.shift();
	const command = args.shift();
	if (
		!command ||
		![
			'status',
			'diff',
			'log',
			'show',
			'ls-files',
			'ls-tree',
			'rev-parse',
			'rev-list',
			'cat-file',
			'branch',
		].includes(command)
	)
		return false;
	if (command === 'branch' && !args.includes('--list')) return false;
	return !args.some(
		(arg) =>
			/^--(?:output|ext-diff|textconv|filters|exec-path|config-env|git-dir|work-tree|super-prefix|end-of-options|submodule)(?:=|$)/.test(
				arg,
			) ||
			['-c', '-C', '--list-cmds', '--help'].includes(arg) ||
			(command === 'branch' &&
				/^-(?:[dDmMcC]|f)|^--(?:delete|move|copy|force|edit-description|set-upstream|unset-upstream)/.test(
					arg,
				)),
	);
}

const planReadTools = new Set([
	'functions.exec',
	'functions.wait',
	'tool_search',
	'skills.list',
	'skills.read',
	'view_image',
	'web.run',
	'image.view',
	'update_plan',
	'request_user_input',
	'send_message_to_user_async',
	'clock.curr_time',
	'clock.sleep',
	'get_goal',
	'get_context_remaining',
	'memories.list',
	'memories.read',
	'memories.search',
	'notes.list_files_by_prefix',
	'notes.read_file',
	'notes.search_contents',
	'history.list_windows',
	'history.list_items',
	'history.read_item',
	'history.search_contents',
	'tasks.list_threads',
	'tasks.list_archived_threads',
	'tasks.read_thread',
	'tasks.wait_threads',
	'workflows.list',
	'scheduler.list',
	'workflows.catalog',
	'workflows.inspect',
	'workflows.validate',
	'workflows.read_run',
]);

/** Shared admission for host execution and renderer-owned task/context tools. */
export function codePlanToolDenial(
	name: string,
	args: Record<string, unknown>,
): string | undefined {
	if (name.startsWith('computer_'))
		return 'Computer Use is unavailable in Plan mode. Leave Plan mode before opening, observing, or controlling an application.';
	if (name === 'exec_command') {
		if (
			args.login === true ||
			args.tty === true ||
			(args.shell !== undefined &&
				!['/bin/sh', '/bin/bash', '/bin/zsh'].includes(String(args.shell))) ||
			typeof args.cmd !== 'string' ||
			!parseCodePlanCommand(args.cmd)
		)
			return 'Plan mode permits only literal read commands and safe pipelines. Scripts, custom shells, expansions, redirections, and commands that may change files are blocked. Use a read tool, or remove Plan mode before implementing.';
		return;
	}
	if (name === 'write_stdin') {
		if (
			args.chars === undefined ||
			args.chars === '' ||
			args.chars === '\u0003' ||
			args.chars === '\u0004'
		)
			return;
		return 'Plan mode cannot send arbitrary input to a process. Poll or stop the process, or remove Plan mode before implementation.';
	}
	if (planReadTools.has(name)) return;
	return `Plan mode blocked ${name}. File edits, generated media, external MCP actions, and changes to tasks or saved knowledge require leaving Plan mode. Continue read-only exploration or present the proposed plan.`;
}
