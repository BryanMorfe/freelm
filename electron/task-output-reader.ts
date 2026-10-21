import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { collectTaskOutputs } from '../src/lib/task-outputs';
import type {
	TaskOutputFileStatus,
	TaskOutputReadResult,
	TaskOutputStatusResult,
} from '../src/task-output-types';
import type { WorkspaceAuthority } from './workspace-authority';

export const MAX_TASK_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_OUTPUT_PREVIEW_BYTES = 256 * 1024;
const BUILTIN_FILE_TOOLS = new Set(['apply_patch', 'exec_command', 'write_stdin']);
const MAX_STATUS_FILES = 1_024;
const MAX_STATUS_ROOTS = 64;
const STATUS_CONCURRENCY = 8;
const STATUS_DEADLINE_MS = 10_000;

export function validateTaskOutputThreadId(threadId: unknown): asserts threadId is string {
	if (
		typeof threadId !== 'string' ||
		!threadId ||
		threadId.length > 256 ||
		/[\u0000-\u001f\u007f]/.test(threadId)
	)
		throw new Error('Invalid task output identifier.');
}

export function validateTaskOutputIds(
	threadId: unknown,
	outputId: unknown,
): asserts threadId is string {
	validateTaskOutputThreadId(threadId);
	if (
		typeof outputId !== 'string' ||
		!outputId ||
		outputId.length > 8192 ||
		/[\u0000-\u001f\u007f]/.test(outputId)
	)
		throw new Error('Invalid task output identifier.');
}

function within(filename: string, root: string) {
	const relative = path.relative(root, filename);
	return (
		relative === '' ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	);
}

interface OutputScope {
	canonical: string;
	aliases: string[];
}
class OutputPathError extends Error {}

/** Configured roots grant scope; their canonical aliases grant exactly the same scope. */
async function outputScope(root: string): Promise<OutputScope> {
	if (!path.isAbsolute(root))
		throw new OutputPathError('The task directory is not an absolute path.');
	const configured = path.resolve(root);
	const canonical = await realpath(configured);
	if (!(await lstat(canonical)).isDirectory())
		throw new OutputPathError('The task directory is not available as a regular directory.');
	const aliases = [configured, canonical];
	// macOS supplies these system aliases. Verify the exact root before accepting either
	// spelling; never resolve an arbitrary caller-supplied path outside configured scope.
	if (process.platform === 'darwin') {
		for (const [alias, target] of [
			['/tmp', '/private/tmp'],
			['/var', '/private/var'],
		] as const) {
			if (!within(canonical, target)) continue;
			const spelling = path.join(alias, path.relative(target, canonical));
			if ((await realpath(spelling).catch(() => undefined)) === canonical) aliases.push(spelling);
		}
	}
	return { canonical, aliases: [...new Set(aliases)] };
}

/** Reject symlinks below a trusted canonical task root, without rejecting /tmp itself. */
async function regularPath(filename: string, scopes: OutputScope[]) {
	const spelling = path.resolve(filename);
	const scope = scopes.find((entry) => entry.aliases.some((root) => within(spelling, root)));
	if (!scope)
		throw new OutputPathError('This output is outside the task’s configured directories.');
	const root = scope.aliases.find((alias) => within(spelling, alias))!;
	const canonicalFilename = path.resolve(scope.canonical, path.relative(root, spelling));
	if (!within(canonicalFilename, scope.canonical))
		throw new OutputPathError('This output resolves outside the task’s configured directories.');
	let current = scope.canonical;
	if (!(await lstat(current)).isDirectory())
		throw new OutputPathError('The task directory changed while checking this output.');
	for (const component of path
		.relative(scope.canonical, canonicalFilename)
		.split(path.sep)
		.filter(Boolean)) {
		current = path.join(current, component);
		const info = await lstat(current);
		if (info.isSymbolicLink())
			throw new OutputPathError('Symlink output files cannot be previewed.');
		if (current !== canonicalFilename && !info.isDirectory())
			throw new OutputPathError('The output path is not a regular file.');
	}
	const stat = await lstat(canonicalFilename);
	if (!stat.isFile()) throw new OutputPathError('Only regular output files can be previewed.');
	if ((await realpath(canonicalFilename)) !== canonicalFilename)
		throw new OutputPathError('The output path changed or resolves outside its recorded location.');
	return { filename: canonicalFilename, stat };
}

function unavailable(error: unknown) {
	const code = (error as NodeJS.ErrnoException)?.code;
	const message =
		code === 'ENOENT' || code === 'ENOTDIR'
			? 'This output file is no longer available at its recorded path.'
			: code === 'EACCES' || code === 'EPERM'
				? 'FreeLM cannot verify this output file with the current filesystem permissions.'
				: error instanceof Error
					? error.message
					: 'This output file could not be verified.';
	return message.slice(0, 4_096);
}
function physicalIdentity(stat: Stats, filename: string) {
	return Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino > 0
		? `inode:${stat.dev}:${stat.ino}`
		: `path:${filename}`;
}

/** Refresh only task-recorded candidates: bounded metadata checks, never contents or directory scans. */
export async function taskOutputStatus(
	authority: Pick<WorkspaceAuthority, 'loadTaskOutputState'>,
	threadId: string,
): Promise<TaskOutputStatusResult> {
	validateTaskOutputThreadId(threadId);
	const context = await authority.loadTaskOutputState(threadId);
	const collected = collectTaskOutputs(context.thread, { workspaceRoot: context.workspaceRoot });
	const candidates = collected.items.filter(
		(item) => item.kind === 'local-file' && item.path && BUILTIN_FILE_TOOLS.has(item.toolName),
	);
	const result: TaskOutputStatusResult = {
		threadId,
		files: [],
		notices: [],
		truncated:
			collected.truncated ||
			candidates.length > MAX_STATUS_FILES ||
			context.workspaceRoots.length > MAX_STATUS_ROOTS,
		checkedAt: Date.now(),
	};
	const deadline = Date.now() + STATUS_DEADLINE_MS;
	const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error('The task output verification deadline was reached.');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error('The task output verification deadline was reached.')),
						remaining,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const scopes: OutputScope[] = [];
	for (const root of [...new Set(context.workspaceRoots)].slice(0, MAX_STATUS_ROOTS)) {
		try {
			scopes.push(await bounded(() => outputScope(root)));
		} catch (error) {
			if (result.notices.length < 16)
				result.notices.push(
					`A task directory could not be verified: ${unavailable(error)}`.slice(0, 4_096),
				);
		}
	}
	const selected = candidates.slice(0, MAX_STATUS_FILES);
	result.files = selected.map((item) => ({ id: item.id, exists: false }));
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(STATUS_CONCURRENCY, selected.length) }, async () => {
			while (next < selected.length) {
				const index = next++;
				const item = selected[index];
				const status: TaskOutputFileStatus = result.files[index];
				try {
					if (!scopes.length)
						throw new OutputPathError(
							'Bind this task to an available project directory to verify its output files.',
						);
					if (!path.isAbsolute(item.path!))
						throw new OutputPathError(
							'This older output has no host directory recorded for its relative path.',
						);
					const { filename, stat } = await bounded(() => regularPath(item.path!, scopes));
					Object.assign(status, {
						exists: true,
						canonicalPath: filename,
						identity: physicalIdentity(stat, filename),
					});
				} catch (error) {
					status.unavailable = unavailable(error);
					const code = (error as NodeJS.ErrnoException)?.code;
					if (
						code !== 'ENOENT' &&
						code !== 'ENOTDIR' &&
						result.notices.length < 16 &&
						!result.notices.includes(status.unavailable)
					)
						result.notices.push(status.unavailable);
				}
			}
		}),
	);
	if (result.truncated)
		result.notices.push('Some task outputs could not be checked within the metadata limits.');
	return result;
}

function imageMime(bytes: Buffer): string | undefined {
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
		return 'image/jpeg';
	if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')))
		return 'image/gif';
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
		bytes.subarray(8, 12).toString('ascii') === 'WEBP'
	)
		return 'image/webp';
	return undefined;
}

function textPreview(bytes: Buffer) {
	if (bytes.includes(0)) return;
	// A text preview is plain text only. HTML, SVG, and scripts are never executed/rendered.
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return;
	}
	const prefix = bytes.subarray(0, MAX_TASK_OUTPUT_PREVIEW_BYTES);
	return {
		kind: 'text' as const,
		text: new TextDecoder('utf-8').decode(prefix),
		truncated: bytes.length > prefix.length,
	};
}

/** Reads only a task-recorded file after a user selects its Outputs row. */
export async function readTaskOutput(
	authority: Pick<WorkspaceAuthority, 'loadTaskOutputState'>,
	threadId: string,
	outputId: string,
): Promise<TaskOutputReadResult> {
	validateTaskOutputIds(threadId, outputId);
	const context = await authority.loadTaskOutputState(threadId);
	const output = collectTaskOutputs(context.thread, {
		workspaceRoot: context.workspaceRoot,
	}).items.find((item) => item.id === outputId);
	if (
		!output ||
		output.kind !== 'local-file' ||
		!output.path ||
		!BUILTIN_FILE_TOOLS.has(output.toolName)
	)
		throw new Error('This file is not a recorded output of the selected Code task.');
	const result: TaskOutputReadResult = { id: output.id, name: output.title, path: output.path };
	if (!context.workspaceRoots.length)
		return {
			...result,
			unavailable: 'Bind this task to a project directory before previewing its output files.',
		};
	if (!path.isAbsolute(output.path))
		return {
			...result,
			unavailable: 'This older output has no host directory recorded for its relative path.',
		};
	// Persisted tool records are editable by paired clients. They are display evidence, not
	// authority to read arbitrary host paths. Only host-configured task roots grant scope.
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const roots = await Promise.allSettled(
			context.workspaceRoots.slice(0, MAX_STATUS_ROOTS).map(outputScope),
		);
		const scopes = roots.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
		const { filename, stat } = await regularPath(output.path, scopes);
		result.size = stat.size;
		if (stat.size > MAX_TASK_OUTPUT_BYTES)
			return {
				...result,
				unavailable:
					'This file exceeds the 8 MiB preview and download limit. Copy its path to use it directly.',
			};
		handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
			throw new Error('The output changed while it was being opened. Try again.');
		if ((await realpath(filename)) !== filename)
			throw new Error('The output path changed while it was being opened. Try again.');
		const chunks: Buffer[] = [];
		let length = 0;
		while (true) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_TASK_OUTPUT_BYTES + 1 - length));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_TASK_OUTPUT_BYTES)
				return {
					...result,
					size: length,
					unavailable:
						'This file grew beyond the 8 MiB preview and download limit. Try again after it finishes writing.',
				};
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const bytes = Buffer.concat(chunks);
		const mimeType = imageMime(bytes);
		const preview = mimeType
			? { kind: 'image' as const, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }
			: textPreview(bytes);
		return {
			...result,
			size: bytes.length,
			mimeType: mimeType ?? (preview ? 'text/plain' : 'application/octet-stream'),
			preview,
			downloadUrl: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			...result,
			unavailable:
				code === 'ENOENT'
					? 'This output file is no longer available at its recorded path.'
					: code === 'EACCES' || code === 'EPERM'
						? 'FreeLM cannot read this output file with the current filesystem permissions.'
						: error instanceof Error
							? error.message
							: 'This output file could not be read.',
		};
	} finally {
		await handle?.close();
	}
}
