import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as bufferLimits } from 'node:buffer';
import type { AppState } from '../src/types';
import { normalizeJson } from '../src/json-normalize';
import { validateState } from './validation';
import { atomicWrite, jsonPayload } from './json-file';
import { MediaStore } from './media-store';

/** Return only after a private recovery copy without API keys is durable on disk. */
export async function saveWorkspaceRecovery(directory: string, state: AppState): Promise<string> {
	validateState(state);
	const snapshot = normalizeJson(state);
	for (const connection of snapshot.connections) connection.apiKey = '';
	const filename = path.resolve(directory, `freelm-unsaved-${Date.now()}-${randomUUID()}.json`);
	const media = new MediaStore(`${filename}.media`);
	try {
		const workspace = await media.encodeWorkspace({
			format: 'freelm-workspace-v2' as const,
			version: snapshot.version,
			threads: snapshot.threads,
			projects: snapshot.projects,
			generations: snapshot.generations,
		});
		const payload =
			workspace.format === 'freelm-workspace-v3'
				? {
						format: 'freelm-recovery-v2',
						state: {
							...snapshot,
							threads: workspace.threads,
							projects: workspace.projects,
							generations: workspace.generations,
						},
						blobs: workspace.blobs,
					}
				: snapshot;
		// Large strings are written once to the private companion .media folder.
		// The manifest and media folder travel together; neither requires the live profile.
		await atomicWrite(filename, jsonPayload(payload, true));
		return filename;
	} catch (error) {
		throw new Error(
			`Could not save the recovery copy. Your workspace has not been replaced. ${(error as Error).message}`,
		);
	}
}

/** Reads either a legacy standalone JSON copy or a portable manifest plus .media folder. */
export async function loadWorkspaceRecovery(filename: string): Promise<AppState> {
	if ((await stat(filename)).size > Math.min(512 * 1024 * 1024, bufferLimits.MAX_STRING_LENGTH))
		throw new Error('Workspace recovery metadata exceeds its size limit.');
	const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
	let state: unknown = value;
	if (
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(value as { format?: unknown }).format === 'freelm-recovery-v2'
	) {
		const saved = value as { state?: AppState; blobs?: unknown };
		if (!saved.state || typeof saved.state !== 'object' || !Array.isArray(saved.blobs))
			throw new Error('Invalid workspace recovery copy.');
		const workspace = (await new MediaStore(`${filename}.media`).hydrate({
			format: 'freelm-workspace-v3',
			version: saved.state.version,
			threads: saved.state.threads,
			projects: saved.state.projects,
			generations: saved.state.generations,
			blobs: saved.blobs,
		})) as Pick<AppState, 'threads' | 'projects' | 'generations'>;
		state = {
			...saved.state,
			threads: workspace.threads,
			projects: workspace.projects,
			generations: workspace.generations,
		};
	}
	validateState(state);
	const snapshot = normalizeJson(state);
	for (const connection of snapshot.connections) connection.apiKey = '';
	return snapshot;
}
