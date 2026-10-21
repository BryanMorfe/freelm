import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { toolApiName } from '../../src/lib/agent';
import { configuredImageTool } from '../../src/lib/image-tool';
import { configuredVideoTool } from '../../src/lib/video-tool';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState, Attachment } from '../../src/types';

// Browser plugin not available. Exercise the actual App with a synthetic workspace,
// mock provider and IPC bridge; no user profile, network API or inference is used.
test.setTimeout(150_000);
const avif = readFileSync(new URL('../fixtures/reference.avif', import.meta.url));
const png =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==';
const latest: Attachment = {
	name: 'latest-reference.avif',
	type: 'image/avif',
	dataUrl: `data:image/avif;base64,${avif.toString('base64')}`,
};
const history: Attachment[] = [
	{
		name: 'invalid-old-reference.png',
		type: 'image/png',
		dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl',
	},
	{ name: 'old-reference.png', type: 'image/png', dataUrl: png },
	{ ...latest, name: 'old-reference.avif' },
	{ name: 'previous-reference.png', type: 'image/png', dataUrl: png },
	latest,
];

async function fixture(page: Page, kind: 'image' | 'video', reference: boolean) {
	const state = initialState();
	state.theme = 'dark';
	state.backgroundNotifications = false;
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = defaultToolSettings();
	const connection = state.connections[0];
	connection.baseUrl = 'http://media-reference-fixture.invalid/v1';
	connection.chatApi = 'responses';
	connection.models.chat = 'chat-model';
	connection.catalog = [
		{
			id: 'chat-model',
			name: 'Chat model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
	];
	state.toolSettings.imageGeneration = {
		enabled: kind === 'image',
		connectionId: connection.id,
		model: 'image-model',
		size: '',
		quality: '',
	};
	state.toolSettings.videoGeneration = {
		enabled: kind === 'video',
		connectionId: connection.id,
		model: 'video-model',
		size: '',
		seconds: '',
	};
	state.threads = [
		{
			id: 'reference-history',
			title: 'Reference history fixture',
			titleSource: 'manual',
			kind: 'chat',
			connectionId: connection.id,
			model: 'chat-model',
			thinkingMode: 'low',
			createdAt: 1,
			updatedAt: 2,
			messages: [
				{
					id: 'earlier-user',
					role: 'user',
					content: 'Here are earlier reference images.',
					attachments: history,
					createdAt: 1,
				},
				{
					id: 'earlier-assistant',
					role: 'assistant',
					content: 'The references are in this conversation.',
					createdAt: 2,
					completedAt: 2,
				},
			],
		},
	];
	const definition =
		kind === 'image'
			? configuredImageTool(connection, state.toolSettings.imageGeneration, 'chat')
			: configuredVideoTool(connection, state.toolSettings.videoGeneration, 'chat');
	const args = {
		prompt: 'A wooded valley in soft light',
		...(reference ? { num_last_images_to_include: 1 } : {}),
	};
	await page.addInitScript(
		({ serialized, definition, apiName, args }) => {
			let current: AppState = JSON.parse(serialized);
			let revision = 0;
			const control: any = { requests: [], executions: [] };
			(window as any).__mediaReferences = control;
			const json = (body: unknown) => ({
				status: 200,
				contentType: 'application/json',
				encoding: 'text',
				body: JSON.stringify(body),
			});
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_target: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({
					secure: false,
					location: 'Isolated reference selection fixture',
				}),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				onChunk: () => () => {},
				cancel: async () => {},
				toolCancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				toolCatalog: async () => ({ tools: [definition], instructions: '', warnings: [] }),
				toolExecute: async (request: unknown) => {
					control.executions.push(structuredClone(request));
					return { content: [{ type: 'text', text: 'Fixture accepted the generation request.' }] };
				},
				request: async (request: any) => {
					const body = request.body;
					control.requests.push(structuredClone(body));
					if (body.input.some((item: any) => item.type === 'function_call_output'))
						return json({ output_text: 'Reference selection completed.' });
					return json({
						output: [
							{
								type: 'function_call',
								call_id: 'media-reference-call',
								name: apiName,
								arguments: JSON.stringify(args),
							},
						],
					});
				},
			};
		},
		{ serialized: JSON.stringify(state), definition, apiName: toolApiName(definition.name), args },
	);
	await page.goto('/');
	await expect(page).toHaveURL('http://127.0.0.1:5173/');
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: 'Reference history fixture', exact: true }).click();
	await expect(
		page.getByText('The references are in this conversation.', { exact: true }),
	).toBeVisible({ timeout: 30_000 });
	await page.getByLabel('Message', { exact: true }).fill('Generate the wooded valley scene.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant .message-final').last()).toHaveText(
		'Reference selection completed.',
	);
	await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__mediaReferences.executions.length))
		.toBe(1);
	const execution = await page.evaluate(() => (window as any).__mediaReferences.executions[0]);
	expect(execution.name).toBe(definition.name);
	expect(execution.arguments).toEqual(args);
	expect(execution.threadId).toBe('reference-history');
	return execution;
}

for (const kind of ['image', 'video'] as const) {
	for (const reference of [false, true]) {
		test(`${kind} tool ${reference ? 'sends only its requested latest AVIF' : 'omits unrequested AVIF and invalid history images'}`, async ({
			page,
		}) => {
			const errors: string[] = [];
			page.on('pageerror', (error) => errors.push(error.message));
			page.on('console', (entry) => {
				if (entry.type() === 'error') errors.push(entry.text());
			});
			const execution = await fixture(page, kind, reference);
			if (reference) expect(execution.recentImages).toEqual([latest]);
			else expect(execution).not.toHaveProperty('recentImages');
			await page.screenshot({
				path: `/tmp/freelm-${kind}-tool-${reference ? 'reference' : 'text-only'}.png`,
			});
			expect(errors).toEqual([]);
		});
	}
}
