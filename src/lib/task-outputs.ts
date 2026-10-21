import type { ToolCallRecord, ToolFileChange, ToolResult } from '../agent-types';
import type { Thread } from '../types';
import { editedFileChanges } from './edited-files';

/** A current file or immutable downloadable artifact created during this task. */
export interface TaskOutput {
	id: string;
	kind: 'local-file' | 'image' | 'file';
	title: string;
	path?: string;
	/** Canonical outputFiles evidence, not a grant of filesystem read permission. */
	hostConfirmed?: boolean;
	dataUrl?: string;
	mimeType?: string;
	messageId: string;
	callId: string;
	toolName: string;
	createdAt: number;
}
export interface TaskOutputsData {
	items: TaskOutput[];
	hasOutputs: boolean;
	truncated: boolean;
	notices: string[];
}
export interface TaskOutputOptions {
	/** Current task's primary directory, used only to resolve legacy display-relative paths. */
	workspaceRoot?: string;
}

const MAX_MESSAGES = 8_192;
const MAX_CALLS = 32_768;
const MAX_OUTPUTS = 1_024;
const MAX_CHANGES_PER_CALL = 512;
const MAX_CONTENT_PER_CALL = 128;
const MAX_ARGUMENTS = 5 * 1024 * 1024 + 1_024;
const MAX_ARTIFACT_CHARS = 48 * 1024 * 1024;
const MAX_NOTICES = 16;
const READING_TOOLS = new Set([
	'view_image',
	'image.view',
	'web.run',
	'read_mcp_resource',
	'list_mcp_resources',
	'list_mcp_resource_templates',
]);
const LOCAL_OUTPUT_TOOLS = new Set(['apply_patch', 'exec_command', 'write_stdin']);
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Host-owned metadata is optional so older saved tasks continue to work.
type OutputResult = ToolResult & {
	outputFiles?: ToolFileChange[];
	outputTrackingNotices?: string[];
};
interface Artifact {
	index: number;
	kind: 'file' | 'image';
	title: string;
	dataUrl: string;
	mimeType: string;
}
interface Evidence {
	changes: ToolFileChange[];
	hostConfirmed: boolean;
	artifacts: Artifact[];
	truncated: boolean;
	notices: string[];
}
interface EvidenceCache {
	arguments: string;
	name: string;
	status: ToolCallRecord['status'];
	result?: ToolResult;
	value: Evidence;
}
const evidenceCache = new WeakMap<ToolCallRecord, EvidenceCache>();

function safePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4096 &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

/** Normalize lexical POSIX segments only; never guess symlinks, case, or an unspecified root. */
function pathKey(value: string, root?: string): string {
	const path = value.startsWith('/') || !root ? value : `${root}/${value}`;
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
		else if (part === '..' && path.startsWith('/')) continue;
		else parts.push(part);
	}
	return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}` || path;
}
function basename(value: string) {
	return value.split('/').filter(Boolean).at(-1)?.slice(0, 300) || 'Created file';
}
function patchArgument(call: ToolCallRecord): unknown {
	if (call.arguments.length > MAX_ARGUMENTS) return;
	try {
		const args: unknown = JSON.parse(call.arguments);
		if (typeof args === 'string') return args;
		if (record(args)) return args.patch;
	} catch {
		// Early records persisted the raw apply_patch payload rather than a JSON wrapper.
		if (call.arguments.startsWith('*** Begin Patch\n')) return call.arguments;
	}
}
function validatedChanges(value: unknown, canonical = false): ToolFileChange[] {
	if (!Array.isArray(value)) return [];
	const changes: ToolFileChange[] = [];
	for (const item of value.slice(0, MAX_CHANGES_PER_CALL)) {
		if (
			!record(item) ||
			!['add', 'update', 'delete', 'move'].includes(String(item.kind)) ||
			!safePath(item.path) ||
			(canonical && !item.path.startsWith('/')) ||
			(item.kind === 'move' &&
				(!safePath(item.previousPath) || (canonical && !item.previousPath.startsWith('/'))))
		)
			continue;
		changes.push({
			kind: item.kind as ToolFileChange['kind'],
			path: item.path,
			...(item.kind === 'move' ? { previousPath: item.previousPath as string } : {}),
		});
	}
	return changes;
}

function artifact(part: unknown, index: number): Artifact | undefined {
	if (
		!record(part) ||
		!['file', 'image'].includes(String(part.type)) ||
		typeof part.dataUrl !== 'string' ||
		part.dataUrl.length > MAX_ARTIFACT_CHARS
	)
		return;
	// Check only the bounded URL header. Large artifact bodies already passed the host bridge;
	// hashing or repeatedly decoding their base64 here would stall the streaming renderer.
	const comma = part.dataUrl.indexOf(',');
	if (comma < 0 || comma > 128 || (part.type === 'image' && comma === part.dataUrl.length - 1))
		return;
	const header = /^data:([a-zA-Z0-9.+/-]+);base64$/.exec(part.dataUrl.slice(0, comma));
	if (
		!header ||
		(part.type === 'image' && !/^image\/(?:png|jpeg|jpg|webp|gif|avif)$/i.test(header[1]))
	)
		return;
	if (
		part.type === 'file' &&
		(typeof part.name !== 'string' ||
			!part.name.trim() ||
			part.name.length > 4096 ||
			/[\u0000-\u001f\u007f]/.test(part.name))
	)
		return;
	return {
		index,
		kind: part.type as Artifact['kind'],
		title:
			typeof part.name === 'string' && part.name.trim()
				? basename(part.name)
				: `Generated image ${index + 1}`,
		dataUrl: part.dataUrl,
		mimeType: header[1].toLowerCase(),
	};
}

function callEvidence(call: ToolCallRecord): Evidence {
	const cached = evidenceCache.get(call);
	if (
		cached &&
		cached.arguments === call.arguments &&
		cached.name === call.name &&
		cached.status === call.status &&
		cached.result === call.result
	)
		return cached.value;
	const value: Evidence = {
		changes: [],
		hostConfirmed: false,
		artifacts: [],
		truncated: false,
		notices: [],
	};
	const result = call.result as OutputResult | undefined;
	const completed = call.status === 'completed' && !result?.isError;
	const rejected =
		call.status === 'denied' || call.status === 'approval' || !!result?.approvalDenied;
	const observedShell =
		['exec_command', 'write_stdin'].includes(call.name) &&
		['completed', 'failed'].includes(call.status);
	if (!rejected && (completed || observedShell)) {
		if (LOCAL_OUTPUT_TOOLS.has(call.name) && Array.isArray(result?.outputFiles)) {
			value.changes = validatedChanges(result.outputFiles, true);
			value.hostConfirmed = true;
			value.truncated = result.outputFiles.length > MAX_CHANGES_PER_CALL;
		} else if (completed && call.name === 'apply_patch') {
			value.changes = validatedChanges(editedFileChanges(call, patchArgument(call)));
		}
		const content = Array.isArray(result?.content) ? result.content : [];
		const hasDownloads = content.some((part) => part.type === 'file');
		if (completed && !READING_TOOLS.has(call.name)) {
			for (let index = 0; index < Math.min(content.length, MAX_CONTENT_PER_CALL); index++) {
				const part = content[index];
				if (
					part.type === 'image' &&
					call.name !== 'image_gen.imagegen' &&
					(call.name !== 'python.exec' || hasDownloads)
				)
					continue;
				const item = artifact(part, index);
				if (item) value.artifacts.push(item);
			}
			if (content.length > MAX_CONTENT_PER_CALL) value.truncated = true;
		}
	}
	for (const notice of Array.isArray(result?.outputTrackingNotices)
		? result.outputTrackingNotices.slice(0, MAX_NOTICES)
		: []) {
		if (typeof notice === 'string' && notice.trim())
			value.notices.push(notice.trim().slice(0, 300));
	}
	evidenceCache.set(call, {
		arguments: call.arguments,
		name: call.name,
		status: call.status,
		result: call.result,
		value,
	});
	return value;
}

interface OrderedCall {
	call: ToolCallRecord;
	messageId: string;
	createdAt: number;
	order: number;
	active: boolean;
}

/**
 * Task outputs reflect physical work from every response version, including inactive paths.
 * Sources remain separate and follow only the selected conversation path. Confirmed additions
 * create rows, subsequent moves follow the file, and confirmed deletion removes it. Recreating
 * that path starts a new output. Other tools' arguments, stdout, and viewed images are never
 * evidence that a file was created. This is recorded tool evidence, not a live filesystem scan.
 */
export function collectTaskOutputs(
	thread: Pick<Thread, 'id' | 'messages' | 'messageHistory'>,
	options: TaskOutputOptions = {},
): TaskOutputsData {
	const data: TaskOutputsData = { items: [], hasOutputs: false, truncated: false, notices: [] };
	const root =
		safePath(options.workspaceRoot) && options.workspaceRoot.startsWith('/')
			? pathKey(options.workspaceRoot)
			: undefined;
	const byCall = new Map<string, OrderedCall>();
	let messages = 0,
		calls = 0,
		order = 0;
	for (const [list, active] of [
		[thread.messageHistory ?? [], false],
		[thread.messages, true],
	] as const) {
		if (list.length > MAX_MESSAGES) data.truncated = true;
		for (const message of list.slice(-MAX_MESSAGES)) {
			if (++messages > MAX_MESSAGES * 2 || message.role !== 'assistant') continue;
			for (const call of message.toolCalls ?? []) {
				if (++calls > MAX_CALLS) {
					data.truncated = true;
					break;
				}
				const key = call.id || `${message.id}:${order}`;
				const existing = byCall.get(key);
				// Active records supersede stale snapshots with the same host-issued call ID.
				if (existing && (existing.active || !active)) continue;
				byCall.set(key, {
					call,
					messageId: message.id,
					active,
					order: order++,
					createdAt: timestamp(call.completedAt)
						? call.completedAt
						: timestamp(call.startedAt)
							? call.startedAt
							: timestamp(message.createdAt)
								? message.createdAt
								: 0,
				});
			}
			if (calls > MAX_CALLS) break;
		}
		if (calls > MAX_CALLS) break;
	}
	const paths = new Map<string, TaskOutput>();
	const artifacts = new Map<string, TaskOutput>();
	const ordered = [...byCall.values()].sort(
		(a, b) => a.createdAt - b.createdAt || a.order - b.order,
	);
	function output(
		item: OrderedCall,
		id: string,
		kind: TaskOutput['kind'],
		title: string,
	): TaskOutput {
		return {
			id,
			kind,
			title,
			messageId: item.messageId,
			callId: item.call.id,
			toolName: item.call.name,
			createdAt: item.createdAt,
		};
	}
	function capacity() {
		if (paths.size + artifacts.size < MAX_OUTPUTS) return true;
		data.truncated = true;
		return false;
	}
	for (const item of ordered) {
		const evidence = callEvidence(item.call);
		data.truncated ||= evidence.truncated;
		for (const notice of evidence.notices) {
			if (!data.notices.includes(notice) && data.notices.length < MAX_NOTICES)
				data.notices.push(notice);
		}
		for (const change of evidence.changes) {
			const key = pathKey(change.path, root);
			if (change.kind === 'delete') paths.delete(key);
			else if (change.kind === 'move') {
				const oldKey = pathKey(change.previousPath!, root);
				const moved = paths.get(oldKey);
				paths.delete(oldKey);
				paths.delete(key);
				if (moved)
					paths.set(key, {
						...moved,
						path: key,
						title: basename(key),
						hostConfirmed: evidence.hostConfirmed,
					});
			} else if (change.kind === 'add' && !paths.has(key) && capacity()) {
				paths.set(key, {
					...output(item, `local:${thread.id}:${item.call.id}:${key}`, 'local-file', basename(key)),
					path: key,
					hostConfirmed: evidence.hostConfirmed,
				});
			} else if (change.kind === 'update' && evidence.hostConfirmed && paths.has(key)) {
				paths.set(key, { ...paths.get(key)!, hostConfirmed: true });
			}
		}
		for (const part of evidence.artifacts) {
			// Python's session output directory is stable for a task; updated exports replace their
			// previous download. Image generation keeps each independently generated result.
			const key =
				item.call.name === 'python.exec' && part.kind === 'file'
					? `python:${part.title}`
					: `${item.call.id}:${part.index}`;
			const prior = artifacts.get(key);
			if (!prior && !capacity()) continue;
			artifacts.set(key, {
				...output(item, prior?.id ?? `artifact:${thread.id}:${key}`, part.kind, part.title),
				createdAt: prior?.createdAt ?? item.createdAt,
				dataUrl: part.dataUrl,
				mimeType: part.mimeType,
			});
		}
	}
	data.items = [...paths.values(), ...artifacts.values()].sort((a, b) => a.createdAt - b.createdAt);
	data.hasOutputs = data.items.length > 0;
	return data;
}
