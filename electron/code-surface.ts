import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
	CodeSurfaceFileResult,
	CodeSurfaceRequest,
	CodeSurfaceResult,
} from '../src/code-surface-types';
import type { ComposerHostScope, ComposerScopeLoader } from './composer-context';
import { buildCodeHtmlPreview, CODE_HTML_PREVIEW_BYTES } from './code-html-preview';

export const CODE_SURFACE_TEXT_BYTES = 2 * 1024 * 1024;
export const CODE_SURFACE_READ_BYTES = 8 * 1024 * 1024;
export const CODE_SURFACE_RESPONSE_BYTES = 16 * 1024 * 1024;
const PREVIEW_BYTES = 256 * 1024;
const LIST_LIMIT = 512;
const DIFF_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown) =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= 256 &&
	!/[\x00-\x1f\x7f]/.test(value);
const validPath = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= 4096 &&
	path.isAbsolute(value) &&
	!/[\x00-\x1f\x7f]/.test(value);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function validateCodeSurfaceRequest(value: unknown): asserts value is CodeSurfaceRequest {
	if (
		!record(value) ||
		Object.keys(value).some(
			(key) =>
				![
					'workspaceId',
					'threadId',
					'projectId',
					'action',
					'path',
					'content',
					'revision',
					'review',
				].includes(key),
		) ||
		!validId(value.workspaceId) ||
		(value.threadId !== undefined && !validId(value.threadId)) ||
		(value.projectId !== undefined && !validId(value.projectId)) ||
		!['list', 'read', 'write', 'diff', 'preview'].includes(value.action as string) ||
		(value.path !== undefined && !validPath(value.path)) ||
		(['read', 'write', 'preview'].includes(value.action as string) && value.path === undefined) ||
		(value.action === 'write'
			? typeof value.content !== 'string' ||
				Buffer.byteLength(value.content, 'utf8') > CODE_SURFACE_TEXT_BYTES ||
				typeof value.revision !== 'string' ||
				!/^[a-f0-9]{64}$/.test(value.revision)
			: value.content !== undefined || value.revision !== undefined) ||
		(value.review !== undefined &&
			(value.action !== 'diff' ||
				!['uncommitted', 'staged', 'unstaged'].includes(value.review as string)))
	)
		throw new Error('Invalid Code surface request.');
}

function inside(root: string, filename: string) {
	const relative = path.relative(root, filename);
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}
interface Root {
	configured: string;
	canonical: string;
}
interface Resolved {
	filename: string;
	stat: Stats;
}
const fingerprint = (scope: ComposerHostScope) =>
	JSON.stringify([scope.kind, scope.projectId, scope.roots, scope.allowRemote]);
async function rootsFor(scope: ComposerHostScope) {
	if (scope.roots.length > 64) throw new Error('This Code workspace has too many directories.');
	const roots: Root[] = [],
		notices: string[] = [];
	for (const configured of scope.roots) {
		if (!validPath(configured))
			throw new Error('The Code workspace has an invalid directory binding.');
		try {
			const canonical = await realpath(configured);
			if (!(await lstat(canonical)).isDirectory()) throw new Error();
			if (!roots.some((root) => root.canonical === canonical))
				roots.push({ configured: path.resolve(configured), canonical });
		} catch {
			notices.push(`Workspace directory unavailable: ${configured}`);
		}
	}
	return { roots, notices };
}
async function resolveScoped(roots: Root[], input: string): Promise<Resolved> {
	const spelling = path.resolve(input);
	const root = [...roots]
		.sort((a, b) => b.canonical.length - a.canonical.length)
		.find((entry) => inside(entry.canonical, spelling) || inside(entry.configured, spelling));
	if (!root) throw new Error('This path is outside the Code workspace directories.');
	const alias = inside(root.canonical, spelling) ? root.canonical : root.configured;
	const filename = path.resolve(root.canonical, path.relative(alias, spelling));
	const components = path.relative(root.canonical, filename).split(path.sep).filter(Boolean);
	if (components.length > 64)
		throw new Error('This path exceeds the workspace directory depth limit.');
	let current = root.canonical;
	if (!(await lstat(current)).isDirectory()) throw new Error('The workspace directory changed.');
	for (const component of components) {
		current = path.join(current, component);
		const info = await lstat(current);
		if (info.isSymbolicLink())
			throw new Error('Symlink files and directories cannot be opened in the Code surface.');
		if (current !== filename && !info.isDirectory())
			throw new Error('This path is not a regular workspace file.');
	}
	const stat = await lstat(filename);
	if (!stat.isDirectory() && !stat.isFile())
		throw new Error('Only regular workspace files and directories can be opened.');
	if ((await realpath(filename)) !== filename)
		throw new Error('The workspace path changed while resolving it.');
	return { filename, stat };
}
async function readBytes(resolved: Resolved, limit = CODE_SURFACE_READ_BYTES) {
	const handle = await open(resolved.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.dev !== resolved.stat.dev || stat.ino !== resolved.stat.ino)
			throw new Error('The file changed while opening it. Reload it and try again.');
		if (stat.size > limit)
			throw new Error(`This file exceeds the ${limit / 1024 / 1024} MiB read limit.`);
		const chunks: Buffer[] = [];
		let size = 0;
		while (true) {
			const part = Buffer.alloc(Math.min(65536, limit + 1 - size));
			const { bytesRead } = await handle.read(part, 0, part.length, null);
			if (!bytesRead) break;
			size += bytesRead;
			if (size > limit) throw new Error('The file grew beyond the Code surface read limit.');
			chunks.push(part.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		if (
			stat.size !== after.size ||
			stat.mtimeMs !== after.mtimeMs ||
			stat.ctimeMs !== after.ctimeMs
		)
			throw new Error('The file changed while reading it. Reload it and try again.');
		return Buffer.concat(chunks);
	} finally {
		await handle.close();
	}
}
function textContent(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return;
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return;
	}
}
function imageMime(bytes: Buffer) {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
		return 'image/jpeg';
	if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
	if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
		return 'image/webp';
	if (bytes.subarray(4, 8).toString() === 'ftyp' && bytes.subarray(8, 12).toString() === 'avif')
		return 'image/avif';
	return undefined;
}
class GitFailure extends Error {}
function git(
	cwd: string,
	args: string[],
	limit = DIFF_BYTES,
	allowNoMatch = false,
): Promise<{ text: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		// Ignore caller Git overrides and disable config-driven helper commands and optional writes.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
		);
		Object.assign(env, {
			GIT_OPTIONAL_LOCKS: '0',
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
		});
		const child = spawn(
			'git',
			[
				'--no-optional-locks',
				'--literal-pathspecs',
				'-c',
				'core.fsmonitor=false',
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'core.quotePath=false',
				...args,
			],
			{ cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const chunks: Buffer[] = [];
		let bytes = 0,
			error = '',
			truncated = false,
			timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, 10000);
		child.stdout.on('data', (chunk: Buffer) => {
			const remaining = limit - bytes;
			if (remaining > 0) {
				chunks.push(chunk.subarray(0, remaining));
				bytes += Math.min(chunk.length, remaining);
			}
			if (chunk.length > remaining) {
				truncated = true;
				child.kill('SIGKILL');
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (error.length < 4096) error += chunk.toString('utf8').slice(0, 4096 - error.length);
		});
		child.on('error', (reason) => {
			clearTimeout(timer);
			reject(new GitFailure(`Git is unavailable: ${reason.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) reject(new GitFailure('Git review exceeded its 10 second deadline.'));
			else if (code !== 0 && !truncated && !(allowNoMatch && code === 1))
				reject(new GitFailure(error.trim() || 'Git could not read the changes in this directory.'));
			else resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
		});
	});
}
async function filterOverrides(directory: string) {
	// --no-textconv/--no-ext-diff do not disable clean/process filters. Git may run
	// those merely to compare working files, so neutralize every configured driver.
	const configured = await git(
		directory,
		[
			'config',
			'--null',
			'--name-only',
			'--get-regexp',
			'^filter\\..*\\.(clean|smudge|process|required)$',
		],
		64 * 1024,
		true,
	);
	if (configured.truncated)
		throw new Error('Git filter configuration exceeds the read-only review limit.');
	const drivers = [
		...new Set(
			configured.text
				.split('\0')
				.filter(Boolean)
				.map((key) => key.replace(/\.(clean|smudge|process|required)$/, '')),
		),
	];
	if (
		drivers.length > 128 ||
		drivers.some((driver) => driver.length > 1024 || /[\x00-\x1f\x7f]/.test(driver))
	)
		throw new Error('Git filter configuration cannot be safely disabled for review.');
	return drivers.flatMap((driver) => [
		'-c',
		`${driver}.clean=`,
		'-c',
		`${driver}.smudge=`,
		'-c',
		`${driver}.process=`,
		'-c',
		`${driver}.required=false`,
	]);
}

async function appendNewFiles(
	directory: string,
	worktree: string,
	pathspec: string,
	roots: Root[],
	result: { text: string; truncated: boolean },
	notices: string[],
	includeTracked = false,
) {
	if (result.truncated) return;
	const inventory = await git(
		directory,
		[
			`--work-tree=${worktree}`,
			'ls-files',
			'-z',
			'--others',
			'--exclude-standard',
			...(includeTracked ? ['--cached'] : []),
			'--',
			pathspec,
		],
		256 * 1024,
	);
	const names = [...new Set(inventory.text.split('\0').filter(Boolean))];
	let budget = DIFF_BYTES - Buffer.byteLength(result.text),
		visited = 0;
	const deadline = Date.now() + 10000;
	result.truncated ||= inventory.truncated;
	for (const name of names) {
		if (++visited > 256 || budget <= 0 || Date.now() > deadline) {
			result.truncated = true;
			break;
		}
		if (
			path.isAbsolute(name) ||
			/[\x00-\x1f\x7f]/.test(name) ||
			!inside(directory, path.resolve(directory, name))
		)
			continue;
		try {
			const selected = await resolveScoped(roots, path.resolve(directory, name));
			if (!selected.stat.isFile()) continue;
			const quote = (value: string) => (/[\s"\\]/.test(value) ? JSON.stringify(value) : value);
			const oldPath = quote(`a/${name}`),
				newPath = quote(`b/${name}`);
			let patch = `diff --git ${oldPath} ${newPath}\nnew file mode ${selected.stat.mode & 0o111 ? '100755' : '100644'}\n`;
			if (selected.stat.size > CODE_SURFACE_TEXT_BYTES) {
				patch += `Binary files /dev/null and ${newPath} differ\n`;
				if (notices.length < 64)
					notices.push(`New file content omitted above the 2 MiB review limit: ${name}`);
			} else {
				const content = textContent(await readBytes(selected, CODE_SURFACE_TEXT_BYTES));
				if (content === undefined) patch += `Binary files /dev/null and ${newPath} differ\n`;
				else if (content.length) {
					const lines = content.split('\n');
					const newline = content.endsWith('\n');
					if (newline) lines.pop();
					patch += `--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}${newline ? '' : '\\ No newline at end of file\n'}`;
				}
			}
			const bytes = Buffer.from(patch);
			result.text += bytes.subarray(0, budget).toString('utf8');
			if (bytes.length > budget) {
				result.truncated = true;
				break;
			}
			budget -= bytes.length;
		} catch (error) {
			if (notices.length < 64)
				notices.push(
					`Could not review new file ${name}: ${error instanceof Error ? error.message : 'Unavailable'}`.slice(
						0,
						4096,
					),
				);
		}
	}
}

/** Host-owned roots authorize reads and explicit user saves; requests never supply new roots. */
export class CodeSurfaceService {
	private pending = 0;
	private writes = new Map<string, Promise<unknown>>();
	constructor(private readonly load: ComposerScopeLoader) {}
	async execute(request: CodeSurfaceRequest, remote = false): Promise<CodeSurfaceResult> {
		validateCodeSurfaceRequest(request);
		if (this.pending >= 8)
			throw new Error('Too many Code surface operations are pending. Try again shortly.');
		this.pending++;
		try {
			const scope = await this.load(request);
			if (scope.kind !== 'code')
				throw new Error('The workspace surface is available only in Code.');
			if (remote && !scope.allowRemote)
				throw new Error(
					'Enable remote Code tools on the host computer before opening its workspace surface.',
				);
			const { roots, notices } = await rootsFor(scope);
			const ensureScope = async () => {
				if (fingerprint(await this.load(request)) !== fingerprint(scope))
					throw new Error('The Code workspace changed. Open this file again in its task.');
			};
			if (request.action === 'list') {
				const rootItems = roots.map((root) => ({
					path: root.canonical,
					name: path.basename(root.configured) || root.configured,
				}));
				if (!request.path) {
					await ensureScope();
					return {
						kind: 'list',
						roots: rootItems,
						entries: rootItems.map((root) => ({ ...root, kind: 'directory' })),
						truncated: false,
						notices,
					};
				}
				const resolved = await resolveScoped(roots, request.path);
				if (!resolved.stat.isDirectory())
					throw new Error('Choose a directory to browse its files.');
				const directory = await opendir(resolved.filename);
				const entries: { name: string; path: string; kind: 'directory' | 'file' }[] = [];
				let truncated = false,
					count = 0;
				try {
					while (true) {
						const entry = await directory.read();
						if (!entry) break;
						if (++count > LIST_LIMIT) {
							truncated = true;
							break;
						}
						if (
							entry.isSymbolicLink() ||
							(!entry.isFile() && !entry.isDirectory()) ||
							/[\x00-\x1f\x7f]/.test(entry.name)
						)
							continue;
						entries.push({
							name: entry.name,
							path: path.join(resolved.filename, entry.name),
							kind: entry.isDirectory() ? 'directory' : 'file',
						});
					}
				} finally {
					await directory.close();
				}
				entries.sort((a, b) =>
					a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
				);
				await ensureScope();
				return {
					kind: 'list',
					roots: rootItems,
					path: resolved.filename,
					entries,
					truncated,
					notices,
				};
			}
			if (!roots.length) throw new Error('Choose an available Code workspace directory first.');
			const resolved = await resolveScoped(roots, request.path || roots[0].canonical);
			if (request.action === 'diff') {
				const directory = resolved.stat.isDirectory()
					? resolved.filename
					: path.dirname(resolved.filename);
				// core.worktree can point outside cwd even when cwd itself is authorized.
				// Verify Git's root contains the selected directory and pin that root for
				// subsequent working-tree reads, including nested project directories.
				const repository = await git(directory, ['rev-parse', '--show-toplevel'], 4096);
				if (repository.truncated)
					throw new Error('The Git workspace path exceeds the review limit.');
				const worktree = await realpath(repository.text.replace(/\r?\n$/, ''));
				if (!inside(worktree, directory))
					throw new Error(
						'Git points outside the selected Code workspace directory. Review is unavailable.',
					);
				const review = request.review || 'uncommitted';
				let unborn = false;
				const args = [
					'diff',
					'--no-ext-diff',
					'--no-textconv',
					'--no-renames',
					'--no-color',
					'--relative',
					'--submodule=short',
					'--src-prefix=a/',
					'--dst-prefix=b/',
				];
				if (review === 'staged') args.push('--cached');
				if (review === 'uncommitted') {
					try {
						await git(directory, ['rev-parse', '--verify', 'HEAD'], 4096);
						args.push('HEAD');
					} catch (error) {
						// An unborn repository still has staged changes; a non-repository remains an error.
						await git(directory, ['rev-parse', '--show-toplevel'], 4096);
						if (!(error instanceof GitFailure)) throw error;
						unborn = true;
						notices.push('This repository has no commit yet; showing current files as additions.');
					}
				}
				const pathspec = resolved.stat.isDirectory() ? '.' : path.basename(resolved.filename);
				args.push('--', pathspec);
				const result = unborn
					? { text: '', truncated: false }
					: await git(directory, [
							`--work-tree=${worktree}`,
							...(await filterOverrides(directory)),
							...args,
						]);
				if (review !== 'staged')
					await appendNewFiles(directory, worktree, pathspec, roots, result, notices, unborn);
				await ensureScope();
				return {
					kind: 'diff',
					path: directory,
					review,
					diff: result.text,
					truncated: result.truncated,
					notices,
				};
			}
			if (!resolved.stat.isFile()) throw new Error('Choose a regular file to open or edit.');
			if (request.action === 'preview') {
				if (!/\.html?$/i.test(resolved.filename))
					throw new Error('Rendered previews are available for HTML files.');
				const root = [...roots]
					.sort((a, b) => b.canonical.length - a.canonical.length)
					.find((item) => inside(item.canonical, resolved.filename))!;
				const preview = await buildCodeHtmlPreview(
					resolved.filename,
					root.canonical,
					async (filename) => {
						const asset = await resolveScoped([root], filename);
						if (!asset.stat.isFile()) throw new Error('This asset is not a regular file.');
						return readBytes(asset);
					},
				);
				await ensureScope();
				return { kind: 'preview', path: resolved.filename, ...preview };
			}
			if (request.action === 'read') {
				const result: CodeSurfaceFileResult = {
					kind: 'file',
					path: resolved.filename,
					name: path.basename(resolved.filename),
					size: resolved.stat.size,
					revision: '',
					editable: false,
					truncated: false,
				};
				if (resolved.stat.size > CODE_SURFACE_READ_BYTES) {
					await ensureScope();
					return { ...result, unavailable: 'This file exceeds the 8 MiB preview limit.' };
				}
				const bytes = await readBytes(resolved),
					mimeType = imageMime(bytes),
					content = textContent(bytes);
				result.size = bytes.length;
				result.revision = digest(bytes);
				if (mimeType)
					result.image = {
						mimeType,
						dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
					};
				else if (content !== undefined) {
					result.editable = bytes.length <= CODE_SURFACE_TEXT_BYTES;
					result.truncated = !result.editable;
					result.content = result.editable
						? content
						: new TextDecoder().decode(bytes.subarray(0, PREVIEW_BYTES));
				} else result.unavailable = 'This binary file has no supported preview.';
				await ensureScope();
				return result;
			}
			const previous = this.writes.get(resolved.filename) ?? Promise.resolve();
			const operation = previous
				.catch(() => {})
				.then(async (): Promise<CodeSurfaceResult> => {
					await ensureScope();
					const current = await resolveScoped(roots, resolved.filename);
					const bytes = await readBytes(current, CODE_SURFACE_TEXT_BYTES);
					if (textContent(bytes) === undefined)
						throw new Error('Binary files cannot be edited in the Code surface.');
					if (digest(bytes) !== request.revision)
						throw new Error(
							'FILE_CONFLICT: This file changed since you opened it. Reload the file before saving.',
						);
					const next = Buffer.from(request.content!, 'utf8');
					if (textContent(next) === undefined)
						throw new Error('The editor can save UTF-8 text only.');
					if (next.equals(bytes))
						return {
							kind: 'saved',
							path: current.filename,
							revision: digest(bytes),
							size: bytes.length,
						};
					const temporary = path.join(
						path.dirname(current.filename),
						`.freelm-save-${randomUUID()}`,
					);
					let handle: Awaited<ReturnType<typeof open>> | undefined;
					try {
						handle = await open(
							temporary,
							constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
							current.stat.mode & 0o777,
						);
						await handle.chmod(current.stat.mode & 0o777);
						await handle.writeFile(next);
						await handle.sync();
						await handle.close();
						handle = undefined;
						await ensureScope();
						const latest = await resolveScoped(roots, current.filename);
						if (
							latest.stat.dev !== current.stat.dev ||
							latest.stat.ino !== current.stat.ino ||
							digest(await readBytes(latest, CODE_SURFACE_TEXT_BYTES)) !== request.revision
						)
							throw new Error(
								'FILE_CONFLICT: This file changed during saving. Reload the file before saving.',
							);
						await rename(temporary, current.filename);
						return {
							kind: 'saved',
							path: current.filename,
							revision: digest(next),
							size: next.length,
						};
					} finally {
						await handle?.close();
						await unlink(temporary).catch(() => {});
					}
				});
			this.writes.set(resolved.filename, operation);
			try {
				return await operation;
			} finally {
				if (this.writes.get(resolved.filename) === operation) this.writes.delete(resolved.filename);
			}
		} finally {
			this.pending--;
		}
	}
}

/** Remote previews are inert data. Reject executable/remote image URLs and malformed payloads. */
export function validCodeSurfaceResult(
	value: unknown,
	request: CodeSurfaceRequest,
): value is CodeSurfaceResult {
	if (!record(value)) return false;
	const string = (v: unknown, max = 4096) => typeof v === 'string' && v.length <= max;
	const notices = (v: unknown) =>
		Array.isArray(v) && v.length <= 128 && v.every((item) => string(item));
	if (request.action === 'list')
		return (
			value.kind === 'list' &&
			Array.isArray(value.roots) &&
			value.roots.length <= 64 &&
			value.roots.every((root) => record(root) && validPath(root.path) && string(root.name)) &&
			(value.path === undefined || validPath(value.path)) &&
			Array.isArray(value.entries) &&
			value.entries.length <= LIST_LIMIT &&
			value.entries.every(
				(entry) =>
					record(entry) &&
					validPath(entry.path) &&
					string(entry.name) &&
					['file', 'directory'].includes(entry.kind as string),
			) &&
			typeof value.truncated === 'boolean' &&
			notices(value.notices)
		);
	if (request.action === 'diff')
		return (
			value.kind === 'diff' &&
			validPath(value.path) &&
			value.review === (request.review || 'uncommitted') &&
			string(value.diff, DIFF_BYTES) &&
			typeof value.truncated === 'boolean' &&
			notices(value.notices)
		);
	if (request.action === 'preview')
		return (
			value.kind === 'preview' &&
			validPath(value.path) &&
			string(value.html, CODE_HTML_PREVIEW_BYTES) &&
			value.url === undefined &&
			notices(value.notices)
		);
	if (
		!validPath(value.path) ||
		typeof value.size !== 'number' ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		typeof value.revision !== 'string' ||
		!/^(?:[a-f0-9]{64})?$/.test(value.revision)
	)
		return false;
	if (request.action === 'write')
		return (
			value.kind === 'saved' &&
			value.revision.length === 64 &&
			value.size <= CODE_SURFACE_TEXT_BYTES
		);
	return (
		value.kind === 'file' &&
		string(value.name) &&
		typeof value.editable === 'boolean' &&
		typeof value.truncated === 'boolean' &&
		(value.content === undefined || string(value.content, CODE_SURFACE_TEXT_BYTES)) &&
		(value.unavailable === undefined || string(value.unavailable)) &&
		(value.image === undefined ||
			(record(value.image) &&
				typeof value.image.mimeType === 'string' &&
				/^image\/(png|jpeg|gif|webp|avif)$/.test(value.image.mimeType) &&
				typeof value.image.dataUrl === 'string' &&
				value.image.dataUrl.startsWith(`data:${value.image.mimeType};base64,`) &&
				value.image.dataUrl.length <= 12 * 1024 * 1024 &&
				/^[A-Za-z0-9+/]*={0,2}$/.test(
					value.image.dataUrl.slice(value.image.dataUrl.indexOf(',') + 1),
				))) &&
		(!value.editable ||
			(typeof value.content === 'string' &&
				value.revision.length === 64 &&
				value.truncated === false &&
				value.image === undefined))
	);
}
