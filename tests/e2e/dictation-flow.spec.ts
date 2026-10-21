import { expect as playwrightExpect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';

const expect = playwrightExpect.configure({ timeout: 15_000 });
test.setTimeout(120_000);
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on('pageerror', (error) => messages.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') messages.push(entry.text());
	});
});
test.afterEach(({ page }) => {
	expect(errors.get(page)).toEqual([]);
});

const editor = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
async function composerText(page: Page) {
	return editor(page).evaluate((element) => {
		const copy = element.cloneNode(true) as HTMLElement;
		copy.querySelectorAll('.cm-placeholder').forEach((placeholder) => placeholder.remove());
		return [...copy.querySelectorAll('.cm-line')].map((line) => line.textContent || '').join('\n');
	});
}
async function control(page: Page, change: Record<string, unknown>) {
	await page.evaluate((change) => Object.assign((window as any).__dictationFlow, change), change);
}
async function draft(page: Page, content: string, id = 'dictation-chat') {
	await expect
		.poll(() =>
			page.evaluate(
				(id) => (window as any).__dictationFlow.state().chatDrafts?.[id]?.content || '',
				id,
			),
		)
		.toBe(content);
}
async function counts(page: Page) {
	return page.evaluate(() => {
		const requests = (window as any).__dictationFlow.requests;
		return {
			asr: requests.filter((request: any) => request.path.includes('/audio/transcriptions')).length,
			chat: requests.filter(
				(request: any) =>
					request.path.includes('/responses') &&
					!String(request.body?.instructions || '').startsWith('Write a short conversation title'),
			).length,
		};
	});
}
async function released(page: Page) {
	await expect
		.poll(() => page.evaluate(() => (window as any).__dictationFlow.stoppedTracks))
		.toBeGreaterThan(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__dictationFlow.closedContexts))
		.toBeGreaterThan(0);
}

// The renderer uses a private in-memory bridge and fake recording/analyser data.
// No microphone permission, hardware, external API, filesystem tools, or real
// FreeLM profile is accessed. The same cases can run against a production preview.
async function fixture(page: Page, configured = true) {
	const state = initialState();
	const connection = state.connections[0];
	connection.baseUrl = 'http://dictation-fixture.invalid/v1';
	connection.models.chat = 'chat-fixture';
	connection.catalog = [
		{
			id: 'chat-fixture',
			name: 'Dictation chat',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
			outputModalities: ['text'],
			thinkingModes: [
				{ id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
			],
		},
		{
			id: 'asr-fixture',
			name: 'Dictation ASR',
			enabled: true,
			tasks: ['transcription'],
			inputModalities: ['audio'],
			outputModalities: ['text'],
			thinkingModes: [],
		},
	];
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = defaultToolSettings();
	state.dictation = {
		enabled: configured,
		connectionId: connection.id,
		model: configured ? 'asr-fixture' : '',
	};
	const now = Date.now();
	const thread = {
		id: 'dictation-chat',
		kind: 'chat' as const,
		title: 'Dictation flow',
		titleSource: 'manual' as const,
		connectionId: connection.id,
		model: 'chat-fixture',
		thinkingMode: 'low',
		createdAt: now,
		updatedAt: now,
		messages: [
			{ id: 'seed-user', role: 'user' as const, content: 'Hello', createdAt: now - 1000 },
			{
				id: 'seed-answer',
				role: 'assistant' as const,
				content: 'Ready',
				createdAt: now,
				completedAt: now,
			},
		],
	};
	state.threads = [
		thread,
		{ ...thread, id: 'other-chat', title: 'Other dictation chat', messages: [] },
	];
	await page.addInitScript(
		({ serialized }) => {
			let current: AppState = JSON.parse(serialized),
				revision = 0;
			const listeners = new Set<(chunk: { id: string; text: string }) => void>();
			const permissionWaiters: ((stream: any) => void)[] = [];
			const asrWaiters: (() => void)[] = [];
			const c: any = {
				requests: [],
				amplitude: 0,
				permission: 'granted',
				holdAsr: false,
				failAsr: false,
				transcript: 'dictated words',
				stoppedTracks: 0,
				closedContexts: 0,
				permissionCalls: 0,
				state: () => current,
				releasePermission: () =>
					permissionWaiters.splice(0).forEach((resolve) => resolve(stream())),
				releaseAsr: () => asrWaiters.splice(0).forEach((resolve) => resolve()),
			};
			(window as any).__dictationFlow = c;
			function stream() {
				let stopped = false;
				const track = {
					stop: () => {
						if (!stopped) {
							stopped = true;
							c.stoppedTracks++;
						}
					},
				};
				return { getTracks: () => [track], getAudioTracks: () => [track] };
			}
			Object.defineProperty(navigator, 'mediaDevices', {
				configurable: true,
				value: {
					getUserMedia: async () => {
						c.permissionCalls++;
						if (c.permission === 'denied')
							throw new DOMException('Fixture microphone denied', 'NotAllowedError');
						if (c.permission === 'pending')
							return new Promise((resolve) => permissionWaiters.push(resolve));
						return stream();
					},
				},
			});
			class AudioContextFixture {
				state = 'running';
				createMediaStreamSource() {
					return { connect: () => {}, disconnect: () => {} };
				}
				createAnalyser() {
					return {
						fftSize: 256,
						frequencyBinCount: 128,
						connect: () => {},
						disconnect: () => {},
						getFloatTimeDomainData: (values: Float32Array) =>
							values.forEach((_, index) => {
								values[index] = index % 2 ? c.amplitude : -c.amplitude;
							}),
						getByteTimeDomainData: (values: Uint8Array) =>
							values.forEach((_, index) => {
								values[index] = 128 + Math.round((index % 2 ? 1 : -1) * c.amplitude * 120);
							}),
						getByteFrequencyData: (values: Uint8Array) =>
							values.fill(Math.round(c.amplitude * 255)),
					};
				}
				async resume() {
					this.state = 'running';
				}
				async close() {
					if (this.state !== 'closed') {
						this.state = 'closed';
						c.closedContexts++;
					}
				}
			}
			(window as any).AudioContext = AudioContextFixture;
			(window as any).webkitAudioContext = AudioContextFixture;
			class RecorderFixture {
				static isTypeSupported() {
					return true;
				}
				state = 'inactive';
				mimeType = 'audio/webm';
				ondataavailable?: (event: any) => void;
				onstop?: () => void;
				onerror?: () => void;
				start() {
					this.state = 'recording';
				}
				stop() {
					if (this.state === 'inactive') return;
					this.state = 'inactive';
					this.ondataavailable?.({
						data: new Blob(['private audio fixture'], { type: this.mimeType }),
					});
					this.onstop?.();
				}
			}
			(window as any).MediaRecorder = RecorderFixture;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Private dictation fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				toolCancel: async () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				onChunk: (listener: any) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				request: async (request: any) => {
					c.requests.push(request);
					if (request.path.includes('/audio/transcriptions')) {
						if (c.holdAsr) await new Promise<void>((resolve) => asrWaiters.push(resolve));
						return {
							status: c.failAsr ? 500 : 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify(
								c.failAsr ? { error: { message: 'Fixture ASR failure' } } : { text: c.transcript },
							),
						};
					}
					for (const data of [
						{ type: 'response.output_text.delta', delta: 'Dictation answer' },
						{ type: 'response.completed', response: { output_text: 'Dictation answer' } },
					])
						for (const listener of listeners)
							listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
					return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
				},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await page.getByRole('button', { name: 'Dictation flow', exact: true }).click();
	await expect(editor(page)).toBeVisible({ timeout: 30_000 });
}

async function waveformRows(page: Page) {
	return page.locator('canvas.dictation-waveform').evaluate((element) => {
		const canvas = element as HTMLCanvasElement;
		const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		const background = [...pixels.slice(0, 4)];
		let rows = 0;
		for (let y = 0; y < canvas.height; y++) {
			let painted = false;
			for (let x = 0; x < canvas.width; x++) {
				const offset = (y * canvas.width + x) * 4;
				if (background.some((channel, index) => Math.abs(channel - pixels[offset + index]) > 16)) {
					painted = true;
					break;
				}
			}
			if (painted) rows++;
		}
		return { rows, height: canvas.height };
	});
}

test('recording replaces the toolbar, waveform follows microphone amplitude, and Stop inserts at the cursor without sending', async ({
	page,
}) => {
	await fixture(page);
	await editor(page).fill('Before after');
	await editor(page).press('Home');
	for (let step = 0; step < 7; step++) await editor(page).press('ArrowRight');
	await control(page, { holdAsr: true });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.getByRole('group', { name: 'Dictation controls' })).toBeVisible();
	await expect(page.locator('.dictation-session')).toHaveAttribute('data-status', 'recording');
	for (const name of ['Chat model', 'Attach files', 'Send message'])
		await expect(page.getByRole('button', { name, exact: true })).toBeHidden();
	await expect(page.getByRole('img', { name: 'Live microphone waveform' })).toBeVisible();
	const silent = await waveformRows(page);
	await control(page, { amplitude: 0.85 });
	await expect
		.poll(async () => (await waveformRows(page)).rows)
		.toBeGreaterThan(silent.rows + silent.height * 0.2);
	await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
	await expect(page.locator('.dictation-session')).toHaveAttribute('data-status', 'transcribing');
	await expect.poll(() => counts(page)).toEqual({ asr: 1, chat: 0 });
	await editor(page).press('Enter');
	await editor(page).press('ControlOrMeta+Enter');
	expect(await counts(page)).toEqual({ asr: 1, chat: 0 });
	await page.evaluate(() => (window as any).__dictationFlow.releaseAsr());
	await draft(page, 'Before dictated words after');
	expect(await counts(page)).toEqual({ asr: 1, chat: 0 });
	await released(page);
	await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toBeVisible();
	await editor(page).press('ControlOrMeta+z');
	await draft(page, 'Before after');
});

test('Transcribe and send uses the latest draft and attachments exactly once while ASR blocks keyboard sends', async ({
	page,
}) => {
	await fixture(page);
	await editor(page).fill('Original ');
	await page.locator('.composer-tools input[type="file"]').setInputFiles({
		name: 'notes.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('Keep the attachment.'),
	});
	await expect(page.locator('.attachment-preview')).toContainText('notes.txt');
	await control(page, { holdAsr: true });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Transcribe and send', exact: true }).click();
	await expect.poll(() => counts(page)).toEqual({ asr: 1, chat: 0 });
	await editor(page).fill('Current ');
	await editor(page).press('Enter');
	await editor(page).press('ControlOrMeta+Enter');
	expect(await counts(page)).toEqual({ asr: 1, chat: 0 });
	await page.evaluate(() => (window as any).__dictationFlow.releaseAsr());
	await expect.poll(() => counts(page)).toEqual({ asr: 1, chat: 1 });
	await expect
		.poll(() =>
			page.evaluate(() => {
				const request = (window as any).__dictationFlow.requests.find((entry: any) =>
					entry.path.includes('/responses'),
				);
				return request?.body.input.filter((entry: any) => entry.role === 'user').at(-1)?.content[0]
					?.text;
			}),
		)
		.toBe(
			'Current dictated words\n\nAttached document (notes.txt):\n<document>\nKeep the attachment.\n</document>',
		);
	await draft(page, '');
	await expect.poll(() => composerText(page)).toBe('');
	await expect(page.locator('.attachment-preview')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
	expect(await counts(page)).toEqual({ asr: 1, chat: 1 });
	await released(page);
});

for (const newChat of [false, true]) {
	test(`Transcribe and send clears an initially empty composer in ${newChat ? 'a new' : 'an existing'} chat`, async ({
		page,
	}) => {
		await fixture(page);
		if (newChat) await page.getByRole('button', { name: 'New chat', exact: true }).click();
		await expect.poll(() => composerText(page)).toBe('');
		await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
		await page.getByRole('button', { name: 'Transcribe and send', exact: true }).click();
		await expect.poll(() => counts(page)).toEqual({ asr: 1, chat: 1 });
		await expect
			.poll(() =>
				page.evaluate(() => {
					const request = (window as any).__dictationFlow.requests.find((entry: any) =>
						entry.path.includes('/responses'),
					);
					return request?.body.input.filter((entry: any) => entry.role === 'user').at(-1)
						?.content[0]?.text;
				}),
			)
			.toBe('dictated words');
		// Persistence can already be empty while CodeMirror still displays the
		// imperatively inserted transcript. Verify both representations.
		await draft(page, '', newChat ? 'new:chat:general' : 'dictation-chat');
		await expect.poll(() => composerText(page)).toBe('');
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
		await editor(page).press('ControlOrMeta+z');
		await expect.poll(() => composerText(page)).toBe('');
		await draft(page, '', newChat ? 'new:chat:general' : 'dictation-chat');
		expect(await counts(page)).toEqual({ asr: 1, chat: 1 });
	});
}

test('cancel, late microphone permission and navigation discard the recording and late ASR results', async ({
	page,
}) => {
	await fixture(page);
	await editor(page).fill('Keep this');
	await control(page, { permission: 'pending' });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.locator('.dictation-session')).toHaveAttribute('data-status', 'requesting');
	await expect(page.getByRole('status')).toContainText('Waiting for microphone');
	await page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
	await page.evaluate(() => (window as any).__dictationFlow.releasePermission());
	await draft(page, 'Keep this');
	await expect
		.poll(() => page.evaluate(() => (window as any).__dictationFlow.stoppedTracks))
		.toBe(1);
	expect(await counts(page)).toEqual({ asr: 0, chat: 0 });
	await control(page, { permission: 'granted', holdAsr: true });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Transcribe and send', exact: true }).click();
	await expect.poll(() => counts(page)).toEqual({ asr: 1, chat: 0 });
	await page.getByRole('button', { name: 'Other dictation chat', exact: true }).click();
	await editor(page).fill('Other draft');
	await page.evaluate(() => (window as any).__dictationFlow.releaseAsr());
	await draft(page, 'Other draft', 'other-chat');
	expect(await counts(page)).toEqual({ asr: 1, chat: 0 });
	await page.getByRole('button', { name: 'Dictation flow', exact: true }).click();
	await draft(page, 'Keep this');
	await released(page);
	await expect(page.locator('.dictation-session')).toHaveCount(0);
	// Starting a new chat again changes the composer generation, even though
	// its draft scope string is still new:chat:general. A pending send belongs
	// to the previous composer generation and must not write into this one.
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await editor(page).fill('Fresh draft');
	await draft(page, 'Fresh draft', 'new:chat:general');
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Transcribe and send', exact: true }).click();
	await expect.poll(() => counts(page)).toEqual({ asr: 2, chat: 0 });
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await page.evaluate(() => (window as any).__dictationFlow.releaseAsr());
	await draft(page, 'Fresh draft', 'new:chat:general');
	await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
	expect(await counts(page)).toEqual({ asr: 2, chat: 0 });
});

test('microphone denial and ASR failure keep the original draft and return usable idle controls', async ({
	page,
}) => {
	await fixture(page);
	await editor(page).fill('Do not lose this');
	await control(page, { permission: 'denied' });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('denied');
	await draft(page, 'Do not lose this');
	expect(await counts(page)).toEqual({ asr: 0, chat: 0 });
	await control(page, { permission: 'granted', failAsr: true });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Transcribe and send', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Fixture ASR failure');
	await draft(page, 'Do not lose this');
	expect(await counts(page)).toEqual({ asr: 1, chat: 0 });
	await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
	await released(page);
});

test('an unconfigured microphone shows an in-chat notice with setup action; recording fits a narrow window', async ({
	page,
}) => {
	await fixture(page, false);
	await editor(page).fill('Preserve setup draft');
	await page.getByRole('button', { name: 'Configure dictation', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('Dictation needs a transcription model');
	await draft(page, 'Preserve setup draft');
	expect(await page.evaluate(() => (window as any).__dictationFlow.permissionCalls)).toBe(0);
	await page.getByRole('button', { name: 'Open dictation settings', exact: true }).click();
	await expect(
		page.getByRole('combobox', { name: 'Dictation transcription model', exact: true }),
	).toBeVisible();
	await page.getByRole('combobox', { name: 'Dictation transcription model', exact: true }).click();
	await page.getByRole('option', { name: 'Dictation ASR', exact: true }).click();
	await page.getByRole('switch', { name: 'Enable dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Save settings', exact: true }).click();
	await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await page.setViewportSize({ width: 820, height: 700 });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.locator('.dictation-session')).toHaveAttribute('data-status', 'recording');
	const fits = await page.locator('.dictation-session').evaluate((element) => {
		const session = element.getBoundingClientRect();
		return [...element.querySelectorAll('button,canvas')].every((child) => {
			const bounds = child.getBoundingClientRect();
			return (
				bounds.left >= session.left - 1 &&
				bounds.right <= session.right + 1 &&
				bounds.top >= session.top - 1 &&
				bounds.bottom <= session.bottom + 1
			);
		});
	});
	expect(fits).toBe(true);
	await page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
	await draft(page, 'Preserve setup draft');
	await released(page);
});
