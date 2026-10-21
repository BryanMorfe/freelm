import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

async function fixture(page: Page, holdTitle = false) {
	const initial = initialState();
	initial.connections[0].models.chat = 'chat-model';
	initial.connections[0].catalog = [
		{
			id: 'chat-model',
			name: 'chat-model',
			enabled: true,
			tasks: ['chat'],
			inputModalities: ['text'],
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
	await page.addInitScript(
		({ serialized, holdTitle }) => {
			const initial = JSON.parse(serialized) as AppState;
			let state = initial,
				revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const pending = new Map<string, (reason: unknown) => void>();
			const controls: any = { saved: () => state, requestCount: 0 };
			(window as any).__chatTest = controls;
			(window as any).desktop = {
				platform: 'darwin',
				workspaceLoad: async () => ({ state: structuredClone(state), revision: String(revision) }),
				workspaceSave: async (_id: string, _revision: string, next: typeof state) => {
					if (controls.holdSave)
						await new Promise<void>((resolve) => {
							controls.finishSave = resolve;
						});
					state = structuredClone(next);
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: true, location: '/test/.freelm/config.json' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				toolPickDirectory: async () => '/tmp/project-one',
				toolCancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				onChunk: (listener: (event: { id: string; text: string }) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				cancel: async (id: string) => {
					pending.get(id)?.(new DOMException('Cancelled', 'AbortError'));
					pending.delete(id);
				},
				request: async (request: any) => {
					if (request.body.instructions?.startsWith('Write a short conversation title')) {
						if (holdTitle)
							await new Promise<void>((resolve) => {
								controls.finishTitle = resolve;
							});
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ output_text: 'Plan the project workspace' }),
						};
					}
					controls.requestCount++;
					return new Promise((resolve, reject) => {
						pending.set(request.id, reject);
						const emit = (data: unknown) => {
							for (const listener of listeners)
								listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
						};
						emit({
							type: 'response.reasoning_text.delta',
							delta: 'internal reasoning is not prose',
						});
						controls.finish = () => {
							for (const delta of ['Here is ', 'the **plan**', '.'])
								emit({ type: 'response.output_text.delta', delta });
							emit({
								type: 'response.completed',
								response: { output_text: 'Here is the **plan**.' },
							});
							pending.delete(request.id);
							resolve({
								status: 200,
								contentType: 'text/event-stream',
								body: '',
								encoding: 'text',
							});
						};
					});
				},
			};
		},
		{ serialized: JSON.stringify(initial), holdTitle },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
}

test('Thinking shimmer, final text, generated title, and project folders', async ({ page }) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await fixture(page);
	await page.evaluate(() => {
		(window as any).__chatTest.holdSave = true;
	});
	await page.getByLabel('Message', { exact: true }).fill('Help me plan the workspace');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.working-status')).toBeVisible();
	// A deliberately blocked durable save must not delay the ordinary model request.
	await expect.poll(() => page.evaluate(() => (window as any).__chatTest.requestCount)).toBe(1);
	await page.evaluate(() => {
		const control = (window as any).__chatTest;
		control.holdSave = false;
		control.finishSave?.();
	});
	const working = page.locator('.working-status');
	const workingText = working.locator(':scope > .activity-shimmer');
	await expect(working.locator(':scope > span')).toHaveCount(1);
	await expect(workingText).toHaveText('Thinking');
	await expect(workingText.locator('*')).toHaveCount(0);
	await expect(page.locator('.working-elapsed')).toHaveCount(0);
	await expect(workingText).toHaveCSS('animation-name', 'activity-shimmer');
	await expect(workingText).toHaveCSS('animation-duration', '4s');
	const shimmer = await workingText.evaluate(async (element) => {
		const animation = element
			.getAnimations()
			.find(
				(candidate) =>
					candidate instanceof CSSAnimation && candidate.animationName === 'activity-shimmer',
			);
		if (!animation || !(animation.effect instanceof KeyframeEffect))
			throw new Error('The Thinking text must have an active CSS shimmer animation.');
		const originalTime = animation.currentTime;
		const originalPlayState = animation.playState;
		animation.pause();
		await animation.ready;
		try {
			const timing = animation.effect.getTiming();
			const frames = animation.effect.getKeyframes();
			// Seek the animation rather than waiting through a wall-clock cycle.
			const samples = [0, 500, 1000, 2500, 3999, 4500].map((time) => {
				animation.currentTime = time;
				return Number.parseFloat(getComputedStyle(element).backgroundPositionX);
			});
			return {
				duration: timing.duration,
				loops: timing.iterations === Infinity,
				easing: timing.easing,
				offsets: frames.map((frame) => frame.computedOffset),
				samples,
			};
		} finally {
			animation.currentTime = originalTime;
			if (originalPlayState === 'running') animation.play();
		}
	});
	expect(shimmer.duration).toBe(4000);
	expect(shimmer.loops).toBe(true);
	expect(shimmer.easing).toBe('linear');
	expect(shimmer.offsets).toEqual([0, 0.25, 1]);
	const [start, halfway, swept, resting, beforeRepeat, repeatedHalfway] = shimmer.samples;
	expect(Math.abs(swept - start)).toBeGreaterThan(100);
	expect(halfway).toBeCloseTo((start + swept) / 2, 2);
	expect(resting).toBeCloseTo(swept, 2);
	expect(beforeRepeat).toBeCloseTo(swept, 2);
	expect(repeatedHalfway).toBeCloseTo(halfway, 2);
	await expect(page.locator('.messages')).not.toContainText('internal reasoning');
	await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
	await expect(
		page.getByLabel('Message', { exact: true }).locator('.cm-placeholder'),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-chat-thinking.png' });
	await page.evaluate(() => (window as any).__chatTest.finish());
	await expect(page.locator('.message.assistant .message-content')).toHaveText('Here is the plan.');
	await expect(page.locator('.working-status')).toHaveCount(0);
	await expect(page.locator('.history-list')).toContainText('Plan the project workspace');
	await expect
		.poll(() => page.evaluate(() => (window as any).__chatTest.saved().threads[0]?.titleSource))
		.toBe('generated');
	await selectConversationMode(page, 'Code');
	await page.getByRole('button', { name: 'New project', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Project name', { exact: true }).fill('Workspace project');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog.getByRole('alert')).toContainText('Choose 1–32 folders');
	await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
	await expect(dialog.getByLabel('Project directories')).toHaveValue('/tmp/project-one');
	await dialog.getByLabel('Project directories').fill('/tmp/project-one\n/tmp/project-two');
	await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__chatTest.saved().projects[0]?.directories))
		.toEqual(['/tmp/project-one', '/tmp/project-two']);
	await expect(page.locator('.project-context')).toHaveCount(0);
	await expect(
		page.getByRole('heading', { name: 'What should we work on in Workspace project?' }),
	).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-chat-project.png' });
	expect(errors).toEqual([]);
});

test('manual rename wins over a late generated title and reduced motion stops shimmer', async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await fixture(page, true);
	await page.getByLabel('Message', { exact: true }).fill('An original question');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.working-status')).toBeVisible();
	const working = page.locator('.working-status');
	const workingText = working.locator(':scope > .activity-shimmer');
	await expect(working.locator(':scope > span')).toHaveCount(1);
	await expect(workingText).toHaveText('Thinking');
	await expect(workingText.locator('*')).toHaveCount(0);
	await expect(workingText).toHaveCSS('animation-name', 'none');
	await expect(workingText).toHaveCSS('background-image', 'none');
	expect(await workingText.evaluate((element) => element.getAnimations().length)).toBe(0);
	expect(await workingText.evaluate((element) => getComputedStyle(element).color)).not.toBe(
		'rgba(0, 0, 0, 0)',
	);
	await page.evaluate(() => (window as any).__chatTest.finish());
	await expect(
		page.getByRole('button', { name: 'Regenerate response', exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Actions for An original question', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
	await page.getByLabel('Chat name', { exact: true }).fill('My chosen title');
	await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
	await page.evaluate(() => (window as any).__chatTest.finishTitle());
	await expect(page.locator('.history-list')).toContainText('My chosen title');
	await expect
		.poll(() => page.evaluate(() => (window as any).__chatTest.saved().threads[0]?.titleSource))
		.toBe('manual');
});
