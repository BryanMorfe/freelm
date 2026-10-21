import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
	startPluginSurfaceRuntime,
	type PluginSurfaceRuntime,
} from '../../electron/plugins/surface-runtime';
import { defaultPluginSettings, validatePluginManifest } from '../../src/lib/plugin-manifest';
import type { PluginHostCall } from '../../electron/plugins/runtime';

const directory = path.join(
	process.cwd(),
	'node_modules',
	`.freelm-example-worker-tests-${process.pid}`,
);
const workerPath = path.join(directory, 'plugin-surface-runtime-worker.cjs');
const sessions: PluginSurfaceRuntime[] = [];
const binding = {
	surface: { kind: 'home', mode: 'chat' },
	workspaceId: 'local',
	composerId: 'composer',
	threadId: 'thread',
	plugin: { id: 'example', name: 'Example' },
};
const state = () => ({
	revision: 1,
	empty: true,
	editable: true,
	focused: true,
	working: false,
	running: false,
	hasAttachments: false,
	hasReply: false,
	hasContext: false,
	pendingAttachments: false,
	queueEditing: false,
	hasQueuedMessages: false,
	awaitingInput: false,
	hasCompletedTurn: true,
});
const callsOf = (calls: { method: string; args: Record<string, unknown> }[], method: string) =>
	calls.filter((call) => call.method === method);
async function launch(name: string, host: PluginHostCall, onError = vi.fn()) {
	const built = await build({
		entryPoints: [`examples/plugins/${name}/src/index.ts`],
		bundle: true,
		format: 'iife',
		globalName: '__freelmPlugin',
		write: false,
		alias: { '@freelm/plugin-sdk': path.join(process.cwd(), 'packages/plugin-sdk/index.ts') },
	});
	const session = await startPluginSurfaceRuntime(
		{
			code: built.outputFiles[0].text,
			context: binding,
			signal: new AbortController().signal,
			workerPath,
			onError,
		},
		host,
	);
	sessions.push(session);
	return { session, onError };
}
beforeAll(async () => {
	await build({
		entryPoints: ['electron/plugins/surface-runtime-worker.ts'],
		outfile: workerPath,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		external: ['quickjs-emscripten'],
	});
});
afterEach(() => sessions.splice(0).forEach((session) => session.dispose()));
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function followupHost(options: { defer?: boolean } = {}) {
	const manifest = validatePluginManifest(
		JSON.parse(await readFile('examples/plugins/follow-up/manifest.json', 'utf8')),
	);
	const values = defaultPluginSettings(manifest);
	const current = state();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	let cancelled = false;
	let release: ((result: { text: string }) => void) | undefined;
	const host: PluginHostCall = async (method, args, signal) => {
		calls.push({ method, args });
		if (method === 'composer.getState') return { ...current };
		if (method === 'settings.get') return { revision: 1, values };
		if (method === 'conversation.getTurns')
			return {
				snapshotId: 'snapshot',
				revision: 1,
				turns: [
					{
						messages: [
							{ id: 'u1', role: 'user', text: 'Explain sourdough starter.' },
							{ id: 'a1', role: 'assistant', text: 'A starter contains wild yeast and bacteria.' },
						],
					},
				],
				truncated: false,
			};
		if (method === 'inference.generateText') {
			if (!options.defer) return { text: 'How do I feed it?' };
			return new Promise((resolve, reject) => {
				release = resolve;
				signal!.addEventListener(
					'abort',
					() => {
						cancelled = true;
						reject(new Error('Cancelled'));
					},
					{ once: true },
				);
			});
		}
		return null;
	};
	return {
		host,
		calls,
		current,
		get cancelled() {
			return cancelled;
		},
		release: () => release?.({ text: 'A stale suggestion' }),
	};
}

describe('independently packaged example extensions', () => {
	it.each(['hasQueuedMessages', 'awaitingInput'] as const)(
		'does not infer or publish while %s is active',
		async (flag) => {
			const fixture = await followupHost();
			fixture.current[flag] = true;
			const { session, onError } = await launch('follow-up', fixture.host);
			await vi.waitFor(() => expect(callsOf(fixture.calls, 'composer.getState')).toHaveLength(1));
			expect(callsOf(fixture.calls, 'inference.generateText')).toHaveLength(0);
			fixture.current[flag] = false;
			session.event('conversation.completed', { revision: 2 });
			await vi.waitFor(() =>
				expect(callsOf(fixture.calls, 'keybindings.register')).toHaveLength(2),
			);
			fixture.current[flag] = true;
			session.event('composer.stateChanged', { ...fixture.current });
			await vi.waitFor(() =>
				expect(callsOf(fixture.calls, 'composer.placeholder.remove')).toHaveLength(1),
			);
			expect(onError).not.toHaveBeenCalled();
		},
	);
	it('reports inference failures without disabling the conversation or losing future completion events', async () => {
		const fixture = await followupHost();
		let attempts = 0;
		const reports: unknown[] = [];
		const { session, onError } = await launch('follow-up', async (method, args, signal) => {
			if (method === 'inference.generateText' && ++attempts === 1)
				throw new Error('Fixture model unavailable.');
			if (method === 'diagnostics.report') {
				reports.push(args);
				return null;
			}
			return fixture.host(method, args, signal);
		});
		await vi.waitFor(() => expect(reports).toHaveLength(1));
		expect(JSON.stringify(reports[0])).toContain('Fixture model unavailable.');
		expect(callsOf(fixture.calls, 'composer.setPlaceholder')).toHaveLength(0);
		session.event('conversation.completed', { revision: 2 });
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'composer.setPlaceholder')).toHaveLength(1),
		);
		expect(onError).not.toHaveBeenCalled();
	});
	it('uses only general context/inference/presentation APIs and registers Tab and Escape without reading the draft', async () => {
		const fixture = await followupHost();
		const { session, onError } = await launch('follow-up', fixture.host);
		await vi.waitFor(() => expect(callsOf(fixture.calls, 'keybindings.register')).toHaveLength(2));
		expect(callsOf(fixture.calls, 'conversation.getTurns')[0].args).toEqual({ limit: 3 });
		expect(callsOf(fixture.calls, 'inference.generateText')[0].args).toMatchObject({
			model: { source: 'conversation' },
			snapshotId: 'snapshot',
			maxOutputTokens: 8192,
		});
		expect(callsOf(fixture.calls, 'composer.setPlaceholder')[0].args).toMatchObject({
			text: 'How do I feed it?',
			expectedRevision: 1,
			acceptCommand: 'accept-follow-up',
		});
		expect(callsOf(fixture.calls, 'commands.register')[0].args.action).toEqual({
			type: 'composer.setText',
			text: 'How do I feed it?',
			expectedRevision: 1,
		});
		expect(callsOf(fixture.calls, 'composer.readDraft')).toHaveLength(0);
		session.command('dismiss-follow-up', { composerRevision: 1 });
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'composer.placeholder.remove')).toHaveLength(1),
		);
		expect(onError).not.toHaveBeenCalled();
	});
	it('cancels on a draft edit during initial inference and does not regenerate after type-erase', async () => {
		const fixture = await followupHost({ defer: true });
		const { session, onError } = await launch('follow-up', fixture.host);
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'inference.generateText')).toHaveLength(1),
		);
		fixture.current.revision = 2;
		fixture.current.empty = false;
		session.event('composer.changed', { ...fixture.current });
		await vi.waitFor(() => expect(fixture.cancelled).toBe(true));
		fixture.release();
		fixture.current.revision = 3;
		fixture.current.empty = true;
		session.event('composer.changed', { ...fixture.current });
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'composer.getState').length).toBeGreaterThanOrEqual(3),
		);
		expect(callsOf(fixture.calls, 'inference.generateText')).toHaveLength(1);
		expect(callsOf(fixture.calls, 'composer.setPlaceholder')).toHaveLength(0);
		expect(onError).not.toHaveBeenCalled();
	});
	it('dismisses while foreground work begins but keeps suggestions through focus-only changes', async () => {
		const fixture = await followupHost();
		const { session } = await launch('follow-up', fixture.host);
		await vi.waitFor(() => expect(callsOf(fixture.calls, 'keybindings.register')).toHaveLength(2));
		fixture.current.focused = false;
		session.event('composer.stateChanged', { ...fixture.current });
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'composer.getState').length).toBeGreaterThanOrEqual(3),
		);
		expect(callsOf(fixture.calls, 'composer.placeholder.remove')).toHaveLength(0);
		fixture.current.working = true;
		session.event('composer.stateChanged', { ...fixture.current });
		await vi.waitFor(() =>
			expect(callsOf(fixture.calls, 'composer.placeholder.remove')).toHaveLength(1),
		);
	});
	it('attaches an owned report through the normal attachment API without reading conversation data', async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const asset = { id: 'asset-1', name: 'report.txt', mimeType: 'text/plain', size: 7 };
		const { session } = await launch('attachment-drawer', async (method, args) => {
			calls.push({ method, args });
			if (method === 'settings.get') return { revision: 1, values: { report: 'Report.' } };
			if (method === 'assets.create') return asset;
			return null;
		});
		await vi.waitFor(() => expect(callsOf(calls, 'composer.drawer.addItem')).toHaveLength(1));
		session.command('attach-report', { composerRevision: 4 });
		await vi.waitFor(() =>
			expect(callsOf(calls, 'composer.attachments.add')[0]?.args).toEqual({
				asset,
				expectedRevision: 4,
			}),
		);
		expect(callsOf(calls, 'conversation.getTurns')).toHaveLength(0);
		expect(callsOf(calls, 'inference.generateText')).toHaveLength(0);
	});
	it('rewrites selected text in a nonempty draft as a revision-checked transaction', async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const { session } = await launch('rewrite-selection', async (method, args) => {
			calls.push({ method, args });
			if (method === 'composer.readDraft')
				return {
					...state(),
					revision: 8,
					empty: false,
					text: 'hello world',
					selection: { anchor: 6, head: 11 },
					attachments: [],
				};
			return null;
		});
		session.command('uppercase-selection', { composerRevision: 8 });
		await vi.waitFor(() =>
			expect(callsOf(calls, 'composer.applyEdit')[0]?.args).toEqual({
				expectedRevision: 8,
				changes: [{ from: 6, to: 11, insert: 'WORLD' }],
			}),
		);
	});
});
