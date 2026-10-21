import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '../../src/types';
import type { WorkflowAsset } from '../../src/workflow-types';
import { isInside, safePath, safeWorkspacePath, workspaceRoots } from '../tools/common';

const MAX_BYTES = 256 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.m4a': 'audio/mp4',
	'.ogg': 'audio/ogg',
	'.flac': 'audio/flac',
	'.json': 'application/json',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.csv': 'text/csv',
	'.pdf': 'application/pdf',
};
export function mimeFor(name: string): string {
	return mimeByExtension[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
export function assetKind(mime: string): WorkflowAsset['kind'] {
	return mime.startsWith('image/')
		? 'image'
		: mime.startsWith('video/')
			? 'video'
			: mime.startsWith('audio/')
				? 'audio'
				: 'file';
}
export function isWorkflowAsset(value: unknown): value is WorkflowAsset {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as WorkflowAsset).path === 'string' &&
		typeof (value as WorkflowAsset).mimeType === 'string'
	);
}
export function inlineBytes(url: string): { bytes: Buffer; mime: string } {
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
	if (!match || match[2].length > MAX_BYTES * 1.4)
		throw new Error('Expected a bounded base64 data URL.');
	const bytes = Buffer.from(match[2], 'base64');
	if (!bytes.length || bytes.length > MAX_BYTES)
		throw new Error('Media exceeds the 256 MiB workflow limit.');
	return { bytes, mime: match[1] };
}

/** Host-managed media references keep binary payloads out of graph/run JSON. */
export class WorkflowAssets {
	constructor(private readonly directory: string) {}
	private async root(): Promise<string> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		return realpath(this.directory);
	}
	async resolve(input: string, workspace: string, allowArtifacts = true): Promise<string> {
		const root = await this.root();
		if (allowArtifacts && path.isAbsolute(input) && isInside(root, path.resolve(input)))
			return safePath(root, input);
		return safeWorkspacePath(await workspaceRoots({ workspaceRoot: workspace }), input);
	}
	async read(
		input: string,
		workspace: string,
		signal: AbortSignal,
		limit = MAX_BYTES,
	): Promise<Buffer> {
		signal.throwIfAborted();
		const filename = await this.resolve(input, workspace);
		const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > limit)
				throw new Error(
					`Workflow input must be a regular file smaller than ${Math.floor(limit / 1024 / 1024)} MiB.`,
				);
			const data = await handle.readFile();
			signal.throwIfAborted();
			if (data.length > limit) throw new Error('Workflow input grew beyond its size limit.');
			return data;
		} finally {
			await handle.close();
		}
	}
	async store(
		bytes: Buffer,
		mimeType: string,
		name: string,
		signal: AbortSignal,
	): Promise<WorkflowAsset> {
		signal.throwIfAborted();
		if (bytes.length > MAX_BYTES) throw new Error('Workflow output exceeds 256 MiB.');
		const safeName =
			path
				.basename(name)
				.replace(/[^a-zA-Z0-9_.-]/g, '_')
				.slice(-160) || 'output.bin';
		const filename = path.join(await this.root(), `${randomUUID()}-${safeName}`);
		const handle = await open(filename, 'wx', 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal.throwIfAborted();
		return { kind: assetKind(mimeType), path: filename, name: safeName, mimeType };
	}
	async storeInline(url: string, name: string, signal: AbortSignal): Promise<WorkflowAsset> {
		const { bytes, mime } = inlineBytes(url);
		return this.store(bytes, mime, name, signal);
	}
	async attachment(value: unknown, workspace: string, signal: AbortSignal): Promise<Attachment> {
		if (typeof value === 'string' && value.startsWith('data:')) {
			const { mime } = inlineBytes(value);
			return { name: 'input', type: mime, dataUrl: value };
		}
		if (
			value &&
			typeof value === 'object' &&
			'dataUrl' in value &&
			typeof value.dataUrl === 'string'
		) {
			const { mime } = inlineBytes(value.dataUrl);
			return {
				name: 'name' in value && typeof value.name === 'string' ? value.name : 'input',
				type: mime,
				dataUrl: value.dataUrl,
			};
		}
		const filename = typeof value === 'string' ? value : isWorkflowAsset(value) ? value.path : '';
		if (!filename) throw new Error('Provide a workflow asset, file path, or inline attachment.');
		const bytes = await this.read(filename, workspace, signal);
		const type = isWorkflowAsset(value) ? value.mimeType : mimeFor(filename);
		return {
			name: isWorkflowAsset(value) ? value.name : path.basename(filename),
			type,
			dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
		};
	}
	async save(
		input: string,
		bytes: Buffer,
		workspace: string,
		overwrite: boolean,
		signal: AbortSignal,
	): Promise<WorkflowAsset> {
		signal.throwIfAborted();
		const filename = await this.resolve(input, workspace, false);
		if (bytes.length > MAX_BYTES) throw new Error('Workflow export exceeds 256 MiB.');
		await mkdir(path.dirname(filename), { recursive: true });
		// Check again after creating directories and reject final-component symlinks at open.
		await this.resolve(input, workspace, false);
		const flags =
			constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_NOFOLLOW |
			(overwrite ? constants.O_TRUNC : constants.O_EXCL);
		const handle = await open(filename, flags, 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return {
			kind: assetKind(mimeFor(filename)),
			path: filename,
			name: path.basename(filename),
			mimeType: mimeFor(filename),
		};
	}
}
