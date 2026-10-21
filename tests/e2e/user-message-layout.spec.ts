import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState, Message, Thread } from '../../src/types';

test.setTimeout(120_000);
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
});
test.afterEach(({ page }) => expect(browserErrors.get(page)).toEqual([]));

// A private workspace and HTTP bridge exercise renderer geometry and actions
// without reading the user's profile or contacting an inference service.
async function fixture(page: Page, longText = false) {
	const state = initialState();
	const connection = state.connections[0];
	connection.baseUrl = 'http://message-layout-fixture.invalid/v1';
	connection.models.chat = 'layout-fixture';
	connection.catalog = [
		{
			id: 'layout-fixture',
			name: 'Layout fixture',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text', 'image'],
			outputModalities: ['text'],
			thinkingModes: [
				{
					id: 'low',
					name: 'Low',
					parameters: {
						responses: { reasoning: { effort: 'low' } },
						chat: { reasoning_effort: 'low' },
					},
				},
			],
		},
	];
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = { ...defaultToolSettings(), enabled: false };
	const dataUrl = `data:image/svg+xml;base64,${Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="170"><rect width="240" height="170" fill="#28546c"/><circle cx="120" cy="85" r="45" fill="#80b8ce"/></svg>',
	).toString('base64')}`;
	const attachment = { name: 'Uploaded image.svg', type: 'image/svg+xml', dataUrl };
	const now = Date.now() - 60_000;
	const messages: Message[] = [
		{
			id: 'text-only',
			role: 'user',
			content: longText
				? `https://example.org/${'unbrokenpath'.repeat(80)}\n\n\`\`\`python\n${'identifier'.repeat(160)}\n\`\`\``
				: 'A short text message.',
			createdAt: now,
		},
		{
			id: 'mixed-image',
			role: 'user',
			content: 'This caption belongs below my image.',
			attachments: [attachment],
			createdAt: now + 1000,
		},
		{
			id: 'image-only',
			role: 'user',
			content: '',
			attachments: [attachment],
			createdAt: now + 2000,
		},
		{
			id: 'layout-answer',
			role: 'assistant',
			content: 'Here is my reply to the uploaded image.',
			createdAt: now + 3000,
			completedAt: now + 4000,
		},
	];
	const thread: Thread = {
		id: 'layout-thread',
		kind: 'chat',
		title: 'User message layout',
		titleSource: 'manual',
		connectionId: connection.id,
		model: 'layout-fixture',
		thinkingMode: 'low',
		createdAt: now,
		updatedAt: now + 4000,
		messages,
	};
	state.threads = [thread];
	await page.addInitScript(
		({ serialized }) => {
			let current: AppState = JSON.parse(serialized),
				revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const control: any = { requests: [], clipboardText: '' };
			(window as any).__messageLayoutFixture = control;
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						control.clipboardText = text;
					},
				},
			});
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
				storageInfo: async () => ({ secure: false, location: 'Private layout fixture' }),
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
					control.requests.push(request);
					for (const data of [
						{ type: 'response.output_text.delta', delta: 'The edited image message was received.' },
						{
							type: 'response.completed',
							response: { output_text: 'The edited image message was received.' },
						},
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
	await expect(page).toHaveTitle('FreeLM');
	await page.getByRole('button', { name: thread.title, exact: true }).click();
	await expect(page.locator('.message.user')).toHaveCount(3);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	return dataUrl;
}

test('uploaded images and actions sit outside text bubbles, with no empty attachment-only bubble', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1100 });
	await fixture(page);
	for (const id of ['text-only', 'mixed-image', 'image-only']) {
		const message = page.locator(`[data-message-id="${id}"]`);
		await expect(message.getByRole('button', { name: 'Edit message', exact: true })).toBeVisible();
		await expect(
			message.getByRole('button', { name: 'Branch conversation', exact: true }),
		).toHaveCount(0);
		const geometry = await message.evaluate((element) => {
			const bubble = element.querySelector('.message-bubble');
			const attachments = element.querySelector('.message-attachments');
			const footer = element.querySelector('.message-footer')!;
			const rect = element.getBoundingClientRect();
			return {
				background: getComputedStyle(element).backgroundColor,
				bubbleBackground: bubble ? getComputedStyle(bubble).backgroundColor : null,
				bubbleButtons: bubble?.querySelectorAll('button').length || 0,
				bubbleImages: bubble?.querySelectorAll('img').length || 0,
				footerIsSibling: footer.parentElement === element,
				attachmentsAreSibling: !attachments || attachments.parentElement === element,
				bubbleBottom: bubble?.getBoundingClientRect().bottom ?? null,
				bubbleTop: bubble?.getBoundingClientRect().top ?? null,
				bubbleRight: bubble?.getBoundingClientRect().right ?? null,
				attachmentsBottom: attachments?.getBoundingClientRect().bottom ?? null,
				attachmentsRight: attachments?.getBoundingClientRect().right ?? null,
				footerTop: footer.getBoundingClientRect().top,
				footerRight: footer.getBoundingClientRect().right,
				right: rect.right,
			};
		});
		expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
		expect(geometry.bubbleButtons).toBe(0);
		expect(geometry.bubbleImages).toBe(0);
		expect(geometry.footerIsSibling).toBe(true);
		expect(geometry.attachmentsAreSibling).toBe(true);
		expect(Math.abs(geometry.footerRight - geometry.right)).toBeLessThan(1);
		if (geometry.bubbleBottom !== null) {
			expect(geometry.bubbleBackground).not.toBe('rgba(0, 0, 0, 0)');
			expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.bubbleBottom);
			expect(Math.abs(geometry.bubbleRight! - geometry.right)).toBeLessThan(1);
		}
		if (geometry.attachmentsBottom !== null) {
			expect(Math.abs(geometry.attachmentsRight! - geometry.right)).toBeLessThan(1);
			expect(geometry.attachmentsBottom).toBeLessThanOrEqual(
				geometry.bubbleTop ?? geometry.footerTop,
			);
		}
	}
	await expect(page.locator('[data-message-id="image-only"] .message-bubble')).toHaveCount(0);
	await expect(
		page
			.locator('[data-message-id="image-only"]')
			.getByRole('button', { name: 'Copy', exact: true }),
	).toHaveCount(0);
	await expect(
		page
			.locator('[data-message-id="layout-answer"]')
			.getByRole('button', { name: 'Branch conversation', exact: true }),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-assistant-branch-only.png', fullPage: false });
});

test('long URLs wrap within their text bubble while code blocks scroll horizontally', async ({
	page,
}) => {
	await fixture(page, true);
	const message = page.locator('[data-message-id="text-only"]');
	const geometry = await message.evaluate((element) => {
		const bubble = element.querySelector('.message-bubble')!;
		const paragraph = bubble.querySelector('p')!;
		const code = bubble.querySelector('pre')!;
		const bubbleRect = bubble.getBoundingClientRect();
		const linkRect = paragraph.querySelector('a')!.getBoundingClientRect();
		return {
			paragraphWidth: paragraph.clientWidth,
			paragraphScrollWidth: paragraph.scrollWidth,
			linkLeft: linkRect.left,
			linkRight: linkRect.right,
			bubbleLeft: bubbleRect.left,
			bubbleRight: bubbleRect.right,
			codeWidth: code.clientWidth,
			codeScrollWidth: code.scrollWidth,
			codeOverflow: getComputedStyle(code).overflowX,
		};
	});
	expect(geometry.paragraphScrollWidth).toBeLessThanOrEqual(geometry.paragraphWidth + 1);
	expect(geometry.linkLeft).toBeGreaterThanOrEqual(geometry.bubbleLeft);
	expect(geometry.linkRight).toBeLessThanOrEqual(geometry.bubbleRight);
	expect(geometry.codeScrollWidth).toBeGreaterThan(geometry.codeWidth);
	expect(geometry.codeOverflow).toBe('auto');
});

test('editing retains separate attachments and actions, and image-only edits can add or omit text', async ({
	page,
}) => {
	const image = await fixture(page);
	const mixed = page.locator('[data-message-id="mixed-image"]');
	await mixed.getByRole('button', { name: 'Edit message', exact: true }).click();
	await expect(mixed.getByLabel('Edit message', { exact: true })).toHaveValue(
		'This caption belongs below my image.',
	);
	await expect(mixed.locator('.message-bubble')).toHaveCount(0);
	await expect(mixed.locator('img')).toHaveAttribute('src', image);
	expect(
		await mixed.evaluate((element) => {
			const form = element.querySelector('.message-edit')!;
			const attachment = element.querySelector('.message-attachments')!;
			return (
				form.parentElement === element &&
				attachment.parentElement === element &&
				attachment.getBoundingClientRect().bottom <= form.getBoundingClientRect().top
			);
		}),
	).toBe(true);
	await mixed.getByLabel('Edit message', { exact: true }).fill('');
	await expect(mixed.getByRole('button', { name: 'Save and send', exact: true })).toBeEnabled();
	await mixed.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(mixed.locator('.message-bubble')).toHaveText('This caption belongs below my image.');
	await mixed.locator('.message-bubble').click({ button: 'right' });
	await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toBeVisible();
	await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click();
	expect(await page.evaluate(() => (window as any).__messageLayoutFixture.clipboardText)).toBe(
		'This caption belongs below my image.',
	);

	const imageOnly = page.locator('[data-message-id="image-only"]');
	await imageOnly.getByRole('button', { name: 'Edit message', exact: true }).click();
	await expect(imageOnly.getByRole('button', { name: 'Save and send', exact: true })).toBeEnabled();
	await imageOnly.getByLabel('Edit message', { exact: true }).fill('A caption added after upload.');
	await imageOnly.getByRole('button', { name: 'Save and send', exact: true }).click();
	await expect(page.locator('.message.assistant').last()).toContainText(
		'The edited image message was received.',
	);
	const edited = page.locator('.message.user').filter({ hasText: 'A caption added after upload.' });
	await expect(edited.locator('.message-bubble')).toHaveText('A caption added after upload.');
	await expect(edited.locator('img')).toHaveAttribute('src', image);
	await expect(edited.locator('.message-versions')).toHaveText('2 / 2');
	await expect(
		edited.getByRole('button', { name: 'Previous response version', exact: true }),
	).toBeEnabled();
	await expect
		.poll(() =>
			page.evaluate(() => JSON.stringify((window as any).__messageLayoutFixture.requests)),
		)
		.toContain(image);
});
