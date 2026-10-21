import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState, ConversationKind, Message, Thread } from '../../src/types';

test.use({ timezoneId: 'America/New_York' });
test.setTimeout(90_000);

const now = new Date('2026-10-01T22:00:00-04:00');
const stamp = (value: string) => new Date(value).getTime();
const message = (id: string, role: Message['role'], value: string, content = id): Message => ({
	id,
	role,
	createdAt: stamp(value),
	content,
	...(role === 'assistant' ? { completedAt: stamp(value) + 60_000 } : {}),
});

// Browser plugin not available. Run the real renderer against an isolated desktop
// bridge; no user profile, host execution or external model API is accessed.
async function fixture(
	page: Page,
	messages: Message[],
	options: { kind?: ConversationKind; clock?: Date; tickingClock?: boolean } = {},
) {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
	const state = initialState();
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = { ...defaultToolSettings(), enabled: false, commandExecution: false };
	state.toolSettings.imageGeneration.enabled = false;
	state.connections[0].baseUrl = 'http://message-dates-fixture.invalid/v1';
	state.connections[0].models.chat = 'date-model';
	state.connections[0].catalog = [
		{
			id: 'date-model',
			name: 'Date model',
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
	const thread: Thread = {
		id: 'date-thread',
		title: 'Message date examples',
		titleSource: 'manual',
		kind: options.kind ?? 'chat',
		connectionId: state.activeConnectionId,
		model: 'date-model',
		thinkingMode: 'low',
		createdAt: messages[0]?.createdAt ?? now.getTime(),
		updatedAt: messages.at(-1)?.createdAt ?? now.getTime(),
		messages,
	};
	state.threads = [thread];
	await page.addInitScript(
		({ serialized }) => {
			let current: AppState = JSON.parse(serialized);
			let revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const control: any = { requests: 0 };
			(window as any).__messageDates = control;
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
				storageInfo: async () => ({ secure: false, location: 'Isolated timestamp fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async () => {},
				toolCancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				request: async (request: any) => {
					control.requests++;
					return new Promise((resolve) => {
						const emit = (data: unknown) => {
							for (const listener of listeners)
								listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
						};
						emit({ type: 'response.reasoning_text.delta', delta: 'A private thought.' });
						control.delta = () =>
							emit({ type: 'response.output_text.delta', delta: 'The stable answer.' });
						control.finish = () => {
							emit({
								type: 'response.completed',
								response: { output_text: 'The stable answer.' },
							});
							resolve({
								status: 200,
								contentType: 'text/event-stream',
								encoding: 'text',
								body: '',
							});
						};
					});
				},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 });
	if (options.tickingClock) await page.clock.install({ time: options.clock ?? now });
	else await page.clock.setFixedTime(options.clock ?? now);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	if (options.kind === 'code')
		await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: thread.title, exact: true }).click();
	await expect(page.locator('.messages')).toBeVisible();
	await expect(page.locator('.message')).toHaveCount(messages.length);
	return errors;
}

async function expectNoOverflow(page: Page) {
	const dimensions = await page.evaluate(() => {
		const messages = document.querySelector('.messages')!;
		return {
			pageWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
			messageWidth: messages.clientWidth,
			messageScrollWidth: messages.scrollWidth,
		};
	});
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.pageWidth + 1);
	expect(dimensions.messageScrollWidth).toBeLessThanOrEqual(dimensions.messageWidth + 1);
}

test('loaded history shows local relative dates, calendar-week boundary and old years', async ({
	page,
}) => {
	const dates = [
		['old-year', '2025-05-15T09:02:00-04:00', 'May 15, 2025 at 9:02 AM'],
		['old-date', '2026-05-15T03:21:00-04:00', 'Fri, May 15 at 3:21 AM'],
		['day-seven', '2026-09-24T20:20:00-04:00', 'Thu, Sep 24 at 8:20 PM'],
		['day-six', '2026-09-25T21:22:00-04:00', 'Friday 9:22 PM'],
		['tuesday', '2026-09-29T21:22:00-04:00', 'Tuesday 9:22 PM'],
		['yesterday', '2026-09-30T06:02:00-04:00', 'Yesterday 6:02 AM'],
		['today', '2026-10-01T16:41:00-04:00', 'Today 4:41 PM'],
	];
	const messages = dates.flatMap(([id, value]) => [
		message(id, 'user', value, `Question from ${id}.`),
		message(`${id}-answer`, 'assistant', value, `Answer for ${id}.`),
	]);
	const errors = await fixture(page, messages);
	await expect(page.locator('.message-date time')).toHaveText(dates.map(([, , label]) => label));
	await expect(page.locator('time.message-time')).toHaveCount(dates.length);
	for (const [id, value] of dates) {
		const previous = page
			.locator(`[data-message-id="${id}"]`)
			.locator('xpath=preceding-sibling::*[1]');
		await expect(previous).toHaveClass('message-date');
		await expect(previous.locator('time')).toHaveAttribute(
			'datetime',
			new Date(value).toISOString(),
		);
	}
	await expectNoOverflow(page);
	expect(errors).toEqual([]);
});

test('first user and exact twenty-minute previous-user gaps remain clear at desktop and narrow widths', async ({
	page,
}) => {
	const messages = [
		message('first', 'user', '2026-10-01T12:00:00-04:00', 'Hello!'),
		message('first-answer', 'assistant', '2026-10-01T12:19:30-04:00', 'Hello. How can I help?'),
		message(
			'under-gap',
			'user',
			'2026-10-01T12:19:59.999-04:00',
			'Tell me about message timestamps.',
		),
		message(
			'second-answer',
			'assistant',
			'2026-10-01T12:39:58-04:00',
			'Times remain visible beneath each answer.',
		),
		message(
			'exact-gap',
			'user',
			'2026-10-01T12:39:59.999-04:00',
			'That makes the conversation easier to follow.',
		),
		message(
			'last-answer',
			'assistant',
			'2026-10-01T12:40:00-04:00',
			'Dates mark the start of a new conversation interval.',
		),
	];
	const errors = await fixture(page, messages);
	await expect(page.locator('.message-date time')).toHaveText(['Today 12:00 PM', 'Today 12:39 PM']);
	await expect(page.locator('time.message-time')).toHaveText(['12:19 PM', '12:39 PM', '12:40 PM']);
	await expect(
		page.locator('[data-message-id="under-gap"]').locator('xpath=preceding-sibling::*[1]'),
	).not.toHaveClass('message-date');
	for (const viewport of [
		{ width: 1440, height: 940 },
		{ width: 560, height: 900 },
	]) {
		await page.setViewportSize(viewport);
		if (viewport.width < 700)
			await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
		await expect(page.locator('.message-date').first()).toBeVisible();
		await expect(page.locator('time.message-time').last()).toBeVisible();
		await expectNoOverflow(page);
		await page.screenshot({
			path: `/tmp/freelm-message-dates-${viewport.width === 1440 ? 'desktop' : 'narrow'}.png`,
		});
	}
	expect(errors).toEqual([]);
});

test('assistant timestamp appears with its actions only after completion and keeps the send time', async ({
	page,
}) => {
	const errors = await fixture(
		page,
		[
			message('previous', 'user', '2026-10-01T20:00:00-04:00', 'An earlier question.'),
			message('previous-answer', 'assistant', '2026-10-01T20:01:00-04:00', 'An earlier answer.'),
		],
		{ clock: new Date('2026-10-01T20:20:00-04:00') },
	);
	await page.getByLabel('Message', { exact: true }).fill('Show me a stable timestamp.');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.working-status')).toBeVisible();
	const answer = page.locator('.message.assistant').last();
	await expect(answer.locator('.message-footer')).toHaveCount(0);
	await page.clock.setFixedTime(new Date('2026-10-01T21:05:00-04:00'));
	await page.evaluate(() => (window as any).__messageDates.delta());
	await expect(answer.locator('.message-content').last()).toHaveText('The stable answer.');
	await expect(answer.locator('.message-footer')).toHaveCount(0);
	await page.evaluate(() => (window as any).__messageDates.finish());
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
	await expect(page.locator('.working-status')).toHaveCount(0);
	await expect(answer.locator('time.message-time')).toHaveText('8:20 PM');
	await expect(answer.locator('time.message-time')).toHaveAttribute(
		'datetime',
		'2026-10-02T00:20:00.000Z',
	);
	await expect(answer.locator('.message-actions')).toHaveCount(1);
	const positions = await answer.evaluate((element) => ({
		content: element.querySelector('.message-content')!.getBoundingClientRect().bottom,
		time: element.querySelector('.message-time')!.getBoundingClientRect().top,
	}));
	expect(positions.time).toBeGreaterThanOrEqual(positions.content);
	expect(errors).toEqual([]);
});

test('message footer reveals time and actions together on hover and keyboard focus without moving the answer', async ({
	page,
}) => {
	const errors = await fixture(page, [
		message('question', 'user', '2026-10-01T20:00:00-04:00', 'Hello, how are you?'),
		message(
			'answer',
			'assistant',
			'2026-10-01T20:01:00-04:00',
			'Hello! What is on your mind today?',
		),
	]);
	const answer = page.locator('[data-message-id="answer"]');
	const footer = answer.locator('.message-footer');
	await page.getByLabel('Message', { exact: true }).click();
	await page.mouse.move(1430, 930);
	await expect(footer).toHaveCSS('opacity', '0');
	await expect(footer).toHaveCSS('pointer-events', 'none');
	const before = await answer.boundingBox();
	await page.screenshot({ path: '/tmp/freelm-message-footer-idle.png' });
	await answer.locator('.message-content').hover();
	await expect(footer).toHaveCSS('opacity', '1');
	await expect(footer).toHaveCSS('pointer-events', 'auto');
	await expect(footer.locator('time')).toHaveText('8:01 PM');
	await expect(footer.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
	expect(await answer.boundingBox()).toEqual(before);
	await page.screenshot({ path: '/tmp/freelm-message-footer-hover.png' });
	await page.getByLabel('Message', { exact: true }).click();
	await page.mouse.move(1430, 930);
	await expect(footer).toHaveCSS('opacity', '0');
	await footer.getByRole('button', { name: 'Copy', exact: true }).focus();
	await page.keyboard.press('Tab');
	await expect(
		footer.getByRole('button', { name: 'Regenerate response', exact: true }),
	).toBeFocused();
	await expect(footer).toHaveCSS('opacity', '1');
	await expect(footer).toHaveCSS('pointer-events', 'auto');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(footer).toHaveCSS('transition-duration', '0s');
	await expectNoOverflow(page);
	expect(errors).toEqual([]);
});

test.describe('touch message footer', () => {
	test.use({ hasTouch: true });
	test('keeps actions and timestamps available on screens without hover', async ({ page }) => {
		const errors = await fixture(page, [
			message('question', 'user', '2026-10-01T20:00:00-04:00', 'A touch screen question.'),
			message('answer', 'assistant', '2026-10-01T20:01:00-04:00', 'The actions stay available.'),
		]);
		await page.setViewportSize({ width: 560, height: 900 });
		await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
		expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
		const footer = page.locator('[data-message-id="answer"] .message-footer');
		await expect(footer).toHaveCSS('opacity', '1');
		await expect(footer).toHaveCSS('pointer-events', 'auto');
		await expect(footer.locator('time')).toHaveText('8:01 PM');
		await expect(footer.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
		await expectNoOverflow(page);
		await page.screenshot({ path: '/tmp/freelm-message-footer-touch.png' });
		expect(errors).toEqual([]);
	});
});

test('dates refresh over local midnight and when a sleeping Code view regains focus', async ({
	page,
}) => {
	const errors = await fixture(
		page,
		[
			message('late-question', 'user', '2026-10-01T23:58:00-04:00', 'A question near midnight.'),
			message('late-answer', 'assistant', '2026-10-01T23:58:30-04:00', 'An answer near midnight.'),
		],
		{ kind: 'code', clock: new Date('2026-10-01T23:59:00-04:00'), tickingClock: true },
	);
	await expect(page.locator('.message-date time')).toHaveText('Today 11:58 PM');
	await page.clock.fastForward(2 * 60_000);
	await expect(page.locator('.message-date time')).toHaveText('Yesterday 11:58 PM');
	await expect(page.locator('time.message-time')).toHaveText('11:58 PM');
	await page.clock.setSystemTime(new Date('2026-10-04T08:00:00-04:00'));
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.locator('.message-date time')).toHaveText('Thursday 11:58 PM');
	await expect(page.locator('time.message-time')).toHaveText('11:58 PM');
	// Simulate the desktop reporting a newly selected viewer timezone on focus.
	// This remains local to this disposable browser context.
	const reportedZone = await page.evaluate(() => {
		const format = Intl.DateTimeFormat;
		const inUtc = (instance: Intl.DateTimeFormat) => {
			const resolve = instance.resolvedOptions.bind(instance);
			Object.defineProperty(instance, 'resolvedOptions', {
				value: () => ({ ...resolve(), timeZone: 'UTC' }),
			});
			return instance;
		};
		Intl.DateTimeFormat = new Proxy(format, {
			apply: (target, receiver, args) => inUtc(Reflect.apply(target, receiver, args)),
			construct: (target, args) => inUtc(Reflect.construct(target, args)),
		});
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	});
	expect(reportedZone).toBe('UTC');
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.locator('.message-date time')).toHaveText('Friday 3:58 AM');
	await expect(page.locator('time.message-time')).toHaveText('3:58 AM');
	expect(errors).toEqual([]);
});
