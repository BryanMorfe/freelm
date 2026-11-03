import { test, expect, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { createWorkflow } from '../../src/lib/workflow-catalog';
import { selectConversationMode } from './helpers/conversation-mode';

test.setTimeout(180_000);
test.use({ actionTimeout: 45_000 });

async function fixture(page: Page) {
	const state = initialState();
	state.connections[0].baseUrl = 'https://fixture.invalid/v1';
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	const workflow = createWorkflow('data');
	workflow.name = 'UI fixture';
	const wf = {
		version: 1,
		hostId: 'fixture',
		workflows: [workflow],
		runs: [],
		bindings: [],
		customNodes: [],
		connections: state.connections,
		projects: [],
		tools: [],
		skills: [],
	};
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.route('**/*', (route) =>
		new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
	);
	await page.addInitScript(
		({ state, wf }) => {
			const control = {
				calls: [] as string[],
				fail: false,
				finish: undefined as undefined | (() => void),
			};
			(window as any).__uiFixture = control;
			localStorage.setItem(
				'freelm-onboarding-v1',
				JSON.stringify({ version: 1, welcomeVersion: 1 }),
			);
			(window as any).desktop = {
				platform: 'darwin',
				workspaceLoad: async () => ({ state, revision: '0' }),
				workspaceSave: async () => ({ revision: '0' }),
				storageInfo: async () => ({ secure: false, location: 'Synthetic UI fixture' }),
				instanceStatus: async () => ({
					host: { running: false, name: 'Fixture', instanceId: 'fixture' },
					instances: [],
				}),
				workflowSnapshot: async () => structuredClone(wf),
				workflowBindings: async () => [],
				workflowCommand: async (command: any) => {
					if (command.type === 'save') {
						wf.workflows = [
							...wf.workflows.filter((w) => w.id !== command.workflow.id),
							command.workflow,
						];
					} else if (command.type === 'install-custom-node') {
						control.calls.push(command.source);
						await new Promise<void>((resolve) => {
							control.finish = resolve;
						});
						if (control.fail) throw new Error('The fixture package is invalid.');
					} else if (command.type !== 'catalog')
						throw new Error('Unexpected fixture action: ' + command.type);
					return structuredClone(wf);
				},
				botsSnapshot: async () => ({
					host: { id: 'fixture', name: 'Fixture' },
					revision: 0,
					bots: [],
					conversations: [],
					connections: state.connections,
				}),
				pluginSnapshot: async () => ({ plugins: [], accounts: [] }),
				pluginCancelConnect: async () => {},
				onToolApproval: () => () => {},
				onOpenThread: () => () => {},
				onPrepareClose: () => () => {},
				onWorkflowsChanged: () => () => {},
			};
		},
		{ state, wf },
	);
	await page.goto('/');
	await expect(page.getByRole('combobox', { name: 'Conversation mode' })).toBeVisible();
	return errors;
}

async function geometry(page: Page) {
	return page.locator('.sidebar-panel-header').evaluate((header) => {
		const title = header.querySelector('.sidebar-mode-picker .select-option-label > span, h2')!;
		const range = document.createRange();
		range.selectNodeContents(title);
		const text = range.getBoundingClientRect();
		const box = header.getBoundingClientRect();
		const style = getComputedStyle(title);
		return {
			height: box.height,
			textX: text.x - box.x,
			textY: text.y - box.y,
			font: style.fontSize,
			line: style.lineHeight,
			actions: [...header.querySelectorAll('.panel-header-actions button')].map((button) => {
				const r = button.getBoundingClientRect();
				return {
					width: r.width,
					height: r.height,
					centerY: r.y + r.height / 2 - box.y,
					right: box.right - r.right,
				};
			}),
		};
	});
}

test('Home-derived headers and searches align at minimum width, themes and collapsed layouts', async ({
	page,
}, info) => {
	const errors = await fixture(page);
	const records = [];
	for (const theme of ['dark', 'light']) {
		await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
		for (const width of [1440, 820]) {
			await page.setViewportSize({ width, height: width === 820 ? 600 : 940 });
			await page.getByRole('button', { name: 'Home', exact: true }).click();
			const home = await geometry(page);
			expect(home.height).toBe(48);
			expect(home.textX).toBe(17);
			await selectConversationMode(page, 'Code');
			expect(await geometry(page)).toEqual(home);
			for (const name of ['Workflows', 'Bots', 'Plugins']) {
				await page.getByRole('button', { name, exact: true }).click();
				await expect(page.locator('.sidebar-panel-header h2')).toHaveText(name);
				const measured = await geometry(page);
				expect(measured.height).toBe(home.height);
				expect(measured.textX).toBe(home.textX);
				expect(Math.abs(measured.textY - home.textY)).toBeLessThanOrEqual(0.5);
				expect(measured.font).toBe(home.font);
				expect(measured.line).toBe(home.line);
				for (const action of measured.actions) {
					expect(action.width).toBe(32);
					expect(action.height).toBe(32);
					expect(action.centerY).toBe(24);
				}
				expect(measured.actions.at(-1)?.right).toBe(13);
				if (name === 'Plugins')
					await page.getByRole('button', { name: 'Search plugins', exact: true }).click();
				const search = page.getByRole('searchbox').first();
				await search.focus();
				await search.fill('missing fixture');
				const searchBox = await search.locator('..').boundingBox();
				expect(searchBox?.height).toBe(30);
				expect(searchBox?.y).toBe(92);
				await expect(search.locator('..')).toHaveCSS('outline-style', 'solid');
				await expect(search.locator('..')).toHaveCSS('outline-width', '2px');
				await page.screenshot({ path: info.outputPath(`${theme}-${width}-${name}.png`) });
				await search.press('Escape');
				if (name === 'Plugins')
					await expect(
						page.getByRole('button', { name: 'Search plugins', exact: true }),
					).toBeFocused();
				else await expect(search).toHaveValue('');
				await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
				await expect(page.locator('.sidebar-panel')).toHaveCount(0);
				await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
				expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
					false,
				);
				records.push({ theme, width, name, home, measured });
			}
		}
	}
	await info.attach('header-geometry', {
		body: JSON.stringify(records, null, 2),
		contentType: 'application/json',
	});
	expect(errors).toEqual([]);
});

test('header actions, keyboard search and file cancellation, failure, busy and same-file reselection work', async ({
	page,
}, info) => {
	const errors = await fixture(page);
	await page.getByRole('button', { name: 'Search chats', exact: true }).press('Enter');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Bots', exact: true }).click();
	for (const name of ['Create bot', 'New bot group']) {
		await page
			.locator('.panel-header-actions')
			.getByRole('button', { name, exact: true })
			.press('Enter');
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
	}
	await page.getByRole('button', { name: 'Workflows', exact: true }).click();
	await page
		.locator('.panel-header-actions')
		.getByRole('button', { name: 'New workflow', exact: true })
		.press('Enter');
	await expect(page.locator('.workflow-canvas')).toBeVisible();
	await page.getByRole('button', { name: 'Add node', exact: true }).click();
	const search = page.getByRole('searchbox', { name: 'Search nodes', exact: true });
	await search.fill('condition');
	await search.press('Escape');
	await expect(search).toHaveValue('');
	const picker = page.locator('.ui-file-picker button');
	const choose = async () => {
		const waiting = page.waitForEvent('filechooser');
		await picker.press('Enter');
		return waiting;
	};
	const cancelled = await choose();
	await cancelled.setFiles([]);
	expect(await page.evaluate(() => (window as any).__uiFixture.calls)).toEqual([]);
	const file = {
		name: 'fixture.freelm-node',
		mimeType: 'application/json',
		buffer: Buffer.from('{"fixture":true}'),
	};
	for (const [index, fail] of [true, false, false].entries()) {
		await page.evaluate((fail) => {
			(window as any).__uiFixture.fail = fail;
		}, fail);
		const chooser = await choose();
		await chooser.setFiles(file);
		await expect(picker).toBeDisabled();
		await expect(picker).toHaveAttribute('aria-busy', 'true');
		await expect(page.locator('.ui-file-picker [role=status]')).toHaveText('Installing package…');
		expect(await page.locator('.ui-file-picker input').inputValue()).toBe('');
		if (index === 2) await search.focus();
		await page.evaluate(() => (window as any).__uiFixture.finish());
		await expect(picker).toBeEnabled();
		await expect(index === 2 ? search : picker).toBeFocused();
		if (fail)
			await expect(
				page.getByText('The fixture package is invalid.', { exact: true }),
			).toBeVisible();
	}
	expect(await page.evaluate(() => (window as any).__uiFixture.calls.length)).toBe(3);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.screenshot({ path: info.outputPath('node-picker-reduced-motion.png') });
	await page.getByRole('button', { name: 'Close node palette' }).click();
	await page.getByRole('button', { name: 'Add node', exact: true }).click();
	await expect(picker).toBeEnabled();
	expect(errors).toEqual([]);
});

test('keyboard focus and interrupted reduced motion remain visible and usable', async ({
	page,
}, info) => {
	const errors = await fixture(page);
	for (const theme of ['light', 'dark']) {
		await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
		await page.getByRole('button', { name: 'Bots', exact: true }).click();
		await page
			.locator('.panel-header-actions')
			.getByRole('button', { name: 'Create bot', exact: true })
			.press('Enter');
		const field = page.getByRole('textbox', { name: 'Name', exact: true });
		await field.focus();
		await expect(field).toHaveCSS('outline-width', '2px');
		await page.screenshot({ path: info.outputPath(`${theme}-input-focus.png`) });
		await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
	}
	await page.evaluate(async () => {
		// Vite serves the actual shared motion module; retain references to inspect cancellation.
		const { animateEntrance, motionScrollBehavior } = await import('/src/lib/motion.ts' as string);
		const target = document.querySelector('.panel-header-actions button') as HTMLElement;
		target.style.setProperty('--motion-enter', '10000ms');
		(window as any).__motionProbe = {
			animateEntrance,
			motionScrollBehavior,
			target,
			animation: animateEntrance(target, [{ opacity: 0.1 }, { opacity: 1 }]),
		};
	});
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect
		.poll(() => page.evaluate(() => (window as any).__motionProbe.animation.playState))
		.toBe('idle');
	expect(
		await page.evaluate(() => {
			const p = (window as any).__motionProbe;
			return {
				scroll: p.motionScrollBehavior(),
				skipped: !p.animateEntrance(p.target, [{ opacity: 0 }, { opacity: 1 }]),
				transition: getComputedStyle(p.target).transitionDuration,
			};
		}),
	).toEqual({ scroll: 'auto', skipped: true, transition: '0s' });
	expect(
		await page.evaluate(() => {
			const span = document.createElement('span');
			span.className = 'spin';
			document.body.append(span);
			const animation = getComputedStyle(span).animationName;
			span.remove();
			return animation;
		}),
	).toBe('none');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	expect(await page.evaluate(() => (window as any).__motionProbe.motionScrollBehavior())).toBe(
		'smooth',
	);
	expect(errors).toEqual([]);
});
