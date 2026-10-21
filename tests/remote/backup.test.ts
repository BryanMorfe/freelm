import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadWorkspaceRecovery, saveWorkspaceRecovery } from '../../electron/workspace-backup';
import type { AppState } from '../../src/types';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
async function directory() {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-recovery-'));
	folders.push(folder);
	return folder;
}
function state(): AppState {
	return {
		version: 1,
		theme: 'dark',
		activeConnectionId: 'api',
		connections: [
			{
				id: 'api',
				name: 'API',
				baseUrl: 'https://example.com/v1',
				apiKey: 'never-write-this-key',
				chatApi: 'responses',
				models: { chat: 'chat', images: '', speech: '', transcription: '', videos: '' },
				discoveredModels: [],
			},
		],
		threads: [],
		projects: [
			{ id: 'unsaved', name: 'Recover me', instructions: 'Unsaved instructions', createdAt: 1 },
		],
		generations: [],
	};
}

describe('workspace recovery copy', () => {
	it('writes unique private snapshots without API keys or changing the live state', async () => {
		const folder = path.join(await directory(), 'recovery'),
			input = state();
		const [first, second] = await Promise.all([
			saveWorkspaceRecovery(folder, input),
			saveWorkspaceRecovery(folder, input),
		]);
		expect(path.isAbsolute(first)).toBe(true);
		expect(first).not.toBe(second);
		const source = await readFile(first, 'utf8');
		expect(source).not.toContain('never-write-this-key');
		expect(JSON.parse(source).projects).toEqual(input.projects);
		expect(JSON.parse(source).connections[0].apiKey).toBe('');
		expect(input.connections[0].apiKey).toBe('never-write-this-key');
		expect((await stat(first)).mode & 0o777).toBe(0o600);
		expect((await stat(folder)).mode & 0o777).toBe(0o700);
		expect((await readdir(folder)).length).toBe(2);
		expect((await readdir(folder)).some((file) => file.endsWith('.tmp'))).toBe(false);
	});
	it('rejects invalid snapshots and filesystem failures before acknowledging recovery', async () => {
		const folder = await directory();
		await expect(saveWorkspaceRecovery(folder, {} as AppState)).rejects.toThrow(
			'Workspace data is invalid',
		);
		expect(await readdir(folder)).toEqual([]);
		const blocked = path.join(folder, 'file');
		await writeFile(blocked, 'keep');
		await expect(saveWorkspaceRecovery(blocked, state())).rejects.toThrow();
		expect(await readFile(blocked, 'utf8')).toBe('keep');
	});
	it('saves and restores a portable recovery gallery above the old aggregate limit', async () => {
		const folder = await directory();
		const input = state();
		const url = 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024);
		input.generations = Array.from({ length: 65 }, (_, index) => ({
			id: `image-${index}`,
			kind: 'images',
			prompt: 'Recover image',
			model: 'fixture',
			connectionId: 'api',
			createdAt: 1,
			status: 'completed',
			assets: [{ url, mimeType: 'image/png', name: 'image.png' }],
		}));
		const file = await saveWorkspaceRecovery(folder, input);
		expect((await stat(file)).size).toBeLessThan(50_000);
		const media = await readdir(`${file}.media`);
		expect(media).toHaveLength(1);
		expect((await stat(path.join(`${file}.media`, media[0]))).mode & 0o777).toBe(0o600);
		const restored = await loadWorkspaceRecovery(file);
		expect(restored.generations).toEqual(input.generations);
		expect(restored.connections[0].apiKey).toBe('');
		expect(input.connections[0].apiKey).toBe('never-write-this-key');
		expect(await readFile(file, 'utf8')).not.toContain('never-write-this-key');
	});
});
