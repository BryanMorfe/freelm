import type { ToolApproval } from '../agent-types';

export interface ApprovalField {
	label: string;
	value: string;
	code?: boolean;
}
export interface ApprovalFile {
	action: 'Add' | 'Update' | 'Delete' | 'Move to';
	path: string;
}
export interface ToolApprovalPresentation {
	action: string;
	kind: 'command' | 'image' | 'video' | 'files' | 'integration' | 'tool';
	message?: string;
	directory?: string;
	command?: string;
	fields: ApprovalField[];
	files?: ApprovalFile[];
	patch?: string;
}

const FIELD_LABELS: Record<string, string> = {
	cmd: 'Command',
	path: 'Path',
	url: 'URL',
	chars: 'Input',
	session_id: 'Process',
	query: 'Search',
	input: 'Input',
	prompt: 'Prompt',
	size: 'Size',
	seconds: 'Duration (seconds)',
	referenced_image_paths: 'Reference images',
	num_last_images_to_include: 'Recent image references',
};

function readableLabel(value: string): string {
	return value.replace(/[._]+/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

function fieldLabel(value: string): string {
	return Object.hasOwn(FIELD_LABELS, value) ? FIELD_LABELS[value] : readableLabel(value);
}

/** Matches the host's lexical path resolution; never rewrites the approved arguments. */
function resolvedPath(value: string, directory?: string): string {
	if (!value.startsWith('/') && !directory) return value;
	const absolute = value.startsWith('/') ? value : `${directory}/${value}`;
	const parts: string[] = [];
	for (const part of absolute.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return `/${parts.join('/')}`;
}

function approvalMessage(approval: ToolApproval): string | undefined {
	let message = approval.message.trim();
	let remote = '';
	if (message.startsWith('Remote FreeLM client request. ')) {
		remote = 'Requested by a remote FreeLM client.';
		message = message.slice('Remote FreeLM client request. '.length);
	}
	if (approval.effectiveDirectory)
		message = message.replace(` Default working directory: ${approval.effectiveDirectory}.`, '');
	const boilerplate = new Set([
		'Allow this command or process input? It runs with your account permissions and is not isolated in an OS sandbox.',
		'Allow this tool action? Review its arguments before continuing.',
		'Allow this local action? Review its arguments before continuing.',
	]);
	if (boilerplate.has(message)) message = '';
	return [remote, message].filter(Boolean).join(' ') || undefined;
}

function boundedValue(value: unknown, depth = 0): string {
	if (typeof value === 'string')
		return value.length > 4096 ? `${value.slice(0, 4096)}… [value truncated]` : value;
	if (value === null) return 'None';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (depth >= 3) return `${value.length} items`;
		const items = value.slice(0, 12).map((item) => boundedValue(item, depth + 1));
		if (value.length > 12) items.push(`… ${value.length - 12} more items`);
		return items.join('\n');
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value);
		if (depth >= 3) return entries.map(([key]) => readableLabel(key)).join(', ');
		const lines = entries
			.slice(0, 12)
			.map(([key, item]) => `${fieldLabel(key)}: ${boundedValue(item, depth + 1)}`);
		if (entries.length > 12) lines.push(`… ${entries.length - 12} more fields`);
		return lines.join('\n');
	}
	return 'Not specified';
}

function argumentFields(args: Record<string, unknown>): ApprovalField[] {
	const entries = Object.entries(args);
	const fields = entries.slice(0, 16).map(([key, value]) => ({
		label: fieldLabel(key),
		value: boundedValue(value),
		code: ['cmd', 'path', 'url', 'session_id'].includes(key),
	}));
	if (entries.length > 16)
		fields.push({
			label: 'Additional fields',
			value: `${entries.length - 16} more fields`,
			code: false,
		});
	return fields;
}

export function toolApprovalPresentation(approval: ToolApproval): ToolApprovalPresentation {
	const args = approval.arguments;
	const presentation: ToolApprovalPresentation = {
		action: readableLabel(approval.name),
		kind: 'tool',
		message: approvalMessage(approval),
		fields: [],
	};
	const directory = approval.effectiveDirectory;
	switch (approval.name) {
		case 'exec_command':
			presentation.action = 'Run command';
			presentation.kind = 'command';
			presentation.command = typeof args.cmd === 'string' ? args.cmd : undefined;
			presentation.directory =
				typeof args.workdir === 'string' ? resolvedPath(args.workdir, directory) : directory;
			if (typeof args.shell === 'string')
				presentation.fields.push({ label: 'Shell', value: args.shell, code: true });
			if (args.login === true)
				presentation.fields.push({ label: 'Shell mode', value: 'Login shell' });
			break;
		case 'write_stdin':
			presentation.action =
				args.chars === '\u0003'
					? 'Interrupt process'
					: args.chars === '\u0004'
						? 'Close process input'
						: 'Send process input';
			presentation.kind = 'command';
			if (typeof args.session_id === 'string')
				presentation.fields.push({ label: 'Process', value: args.session_id, code: true });
			if (typeof args.chars === 'string' && !['\u0003', '\u0004'].includes(args.chars))
				presentation.command = args.chars;
			break;
		case 'view_image':
			presentation.action = 'Read image';
			presentation.kind = 'image';
			if (typeof args.path === 'string')
				presentation.fields.push({
					label: 'Image',
					value: resolvedPath(args.path, directory),
					code: true,
				});
			break;
		case 'apply_patch': {
			presentation.action = 'Edit files';
			presentation.kind = 'files';
			presentation.directory = directory;
			if (typeof args.patch === 'string') {
				presentation.patch = args.patch;
				presentation.files = [];
				for (const line of args.patch.split(/\r?\n/)) {
					const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
					const move = /^\*\*\* Move to: (.+)$/.exec(line);
					if (file)
						presentation.files.push({
							action: file[1] as ApprovalFile['action'],
							path: resolvedPath(file[2], directory),
						});
					else if (move)
						presentation.files.push({ action: 'Move to', path: resolvedPath(move[1], directory) });
				}
			}
			break;
		}
		case 'connect_mcp_servers':
			presentation.action = 'Connect MCP servers';
			presentation.kind = 'integration';
			presentation.fields = argumentFields(args);
			break;
		case 'discover_skills':
			presentation.action = 'Read skill directories';
			presentation.fields = argumentFields(args);
			break;
		case 'image_gen.imagegen':
			presentation.action = 'Generate image';
			presentation.kind = 'image';
			presentation.fields = argumentFields(args);
			break;
		case 'video_gen.videogen':
			presentation.action = 'Generate video';
			presentation.kind = 'video';
			presentation.fields = argumentFields(args);
			break;
		default:
			if (approval.name.startsWith('mcp_')) {
				presentation.action = `Use ${approval.name
					.replace(/^mcp_/, '')
					.replace(/_[a-f\d]{12}$/, '')
					.replace(/_/g, ' ')}`;
				presentation.kind = 'integration';
			}
			presentation.fields = argumentFields(args);
	}
	return presentation;
}
