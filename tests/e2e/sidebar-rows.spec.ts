import { selectConversationMode } from './helpers/conversation-mode';
import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { AppState } from '../../src/types';

test.setTimeout(120_000);

async function openCodeFixture(page: Page) {
	const state = initialState();
	state.projects = [
		{
			id: 'repository',
			name: 'Repository',
			kind: 'code',
			directories: ['/tmp/sidebar-fixture'],
			instructions: '',
			createdAt: 1,
		},
	];
	state.threads = [
		{
			id: 'project-task',
			title: 'Inspect the parser',
			kind: 'code',
			projectId: 'repository',
			connectionId: state.activeConnectionId,
			model: '',
			createdAt: 1,
			updatedAt: 1,
			messages: [{ id: 'request', role: 'user', content: 'Inspect the parser.', createdAt: 1 }],
		},
		{
			id: 'recent-task',
			title: 'Review an example',
			kind: 'code',
			connectionId: state.activeConnectionId,
			model: '',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		},
		{
			id: 'chat-thread',
			title: 'Discuss the example',
			kind: 'chat',
			connectionId: state.activeConnectionId,
			model: '',
			createdAt: 1,
			updatedAt: 1,
			messages: [
				{ id: 'chat-request', role: 'user', content: 'Discuss this example.', createdAt: 1 },
			],
		},
	];
	await page.addInitScript((serialized: string) => {
		let workspace = JSON.parse(serialized) as AppState;
		(window as any).__sidebarWorkspace = () => structuredClone(workspace);
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: async () => ({ state: workspace, revision: '0' }),
			workspaceSave: async (_id: string, _revision: string, next: AppState) => {
				workspace = structuredClone(next);
				return { revision: '0' };
			},
			storageInfo: async () => ({ secure: false, location: '/tmp/sidebar-fixture' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'This computer', instanceId: 'local', port: 4319 },
				instances: [],
			}),
		};
	}, JSON.stringify(state));
	await page.goto('/');
	await selectConversationMode(page, 'Code');
}

test('one Home rail returns to the selected Chat or Code mode and the chooser works at both widths', async ({
	page,
}) => {
	await openCodeFixture(page);
	const rail = page.getByRole('navigation', { name: 'Workspaces', exact: true });
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	await expect(rail.getByRole('button')).toHaveCount(4);
	await expect(page.locator('.rail-separator')).toHaveCount(0);
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 940 });
		await selectConversationMode(page, 'Code');
		await page.getByRole('button', { name: 'Inspect the parser', exact: true }).click();
		for (const media of ['Images', 'Video', 'Audio']) {
			await rail.getByRole('button', { name: media, exact: true }).click();
			await expect(picker).toHaveText('Code');
			await expect(rail.getByRole('button', { name: 'Home' })).not.toHaveAttribute(
				'aria-current',
				'page',
			);
			await rail.getByRole('button', { name: 'Home', exact: true }).click();
			await expect(page.locator('.message.user')).toContainText('Inspect the parser.');
		}
		await picker.press('Enter');
		const menu = page.getByRole('listbox');
		await expect(menu.getByRole('option')).toHaveCount(2);
		await expect(menu).toBeInViewport({ ratio: 1 });
		await page.screenshot({
			path: `/tmp/freelm-home-mode-picker-${width}.png`,
			animations: 'disabled',
		});
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveText('Chat');
		await expect(
			page.getByRole('button', { name: 'Discuss the example', exact: true }),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Inspect the parser', exact: true })).toHaveCount(
			0,
		);
		await rail.getByRole('button', { name: 'Images', exact: true }).click();
		await rail.getByRole('button', { name: 'Home', exact: true }).click();
		await expect(picker).toHaveText('Chat');
		const geometry = await picker.evaluate((element) => {
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			const icon = element.querySelector('svg')!.getBoundingClientRect();
			return {
				size: parseFloat(style.fontSize),
				height: box.height,
				iconInset: box.right - icon.right,
			};
		});
		expect(geometry.size).toBeGreaterThanOrEqual(15);
		expect(geometry.height).toBeGreaterThanOrEqual(30);
		expect(geometry.height).toBeLessThanOrEqual(36);
		expect(geometry.iconInset).toBeGreaterThanOrEqual(8);
	}
});

test('sidebar actions appear on hover or keyboard focus and highlights span complete rows', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await openCodeFixture(page);
	await expect(page).toHaveTitle('FreeLM');
	await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	await page.getByRole('button', { name: 'Inspect the parser', exact: true }).click();
	const project = page.locator('.sidebar-panel .project-row');
	const plus = page.getByRole('button', { name: 'Add to Repository', exact: true });
	const task = page.locator('.project-threads .thread-row');
	const actions = page.getByRole('button', { name: 'Actions for Inspect the parser', exact: true });
	await expect(project).toHaveClass(/active/);
	await expect(plus).toHaveCSS('opacity', '0');
	await expect(plus).toHaveCSS('pointer-events', 'auto');
	// Direct activation must not require a prior hover; otherwise the row intercepts it.
	expect(await plus.evaluate((button) => {
		const box = button.getBoundingClientRect();
		return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
	})).toBe(true);
	await plus.click();
	await expect(page.getByRole('menu', {name: 'Add to Repository', exact: true})).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Home', exact: true }).focus();
	await page.mouse.move(500, 60);
	await project.hover();
	await expect(plus).toHaveCSS('opacity', '1');
	await page.getByRole('button', { name: 'Home', exact: true }).focus();
	await page.mouse.move(500, 60);
	await expect(plus).toHaveCSS('opacity', '0');
	await project.locator('.project-select').focus();
	await page.keyboard.press('Tab');
	await expect(plus).toBeFocused();
	await expect(plus).toHaveCSS('opacity', '1');
	await plus.press('Enter');
	const projectMenu = page.getByRole('menu', { name: 'Add to Repository', exact: true });
	await expect(projectMenu.getByRole('menuitem')).toHaveText(['New task', 'Add workflow']);
	await expect(projectMenu).toBeInViewport({ ratio: 1 });
	await expect(plus).toHaveCSS('opacity', '1');
	await page.screenshot({ path: '/tmp/freelm-project-add-menu-dark.png', animations: 'disabled' });
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));
	await page.screenshot({ path: '/tmp/freelm-project-add-menu-light.png', animations: 'disabled' });
	await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'));
	await page.keyboard.press('Escape');
	await expect(plus).toBeFocused();
	await expect(projectMenu).toHaveCount(0);
	await project.locator('.project-select').click();
	await expect(project.locator('.project-select')).toHaveAttribute('aria-expanded', 'false');
	await plus.press('Enter');
	await projectMenu.getByRole('menuitem', { name: 'New task', exact: true }).click();
	await expect(project.locator('.project-select')).toHaveAttribute('aria-expanded', 'true');
	await expect(
		page.getByRole('heading', { name: 'What should we work on in Repository?', exact: true }),
	).toBeVisible();
	for (const width of [1440, 720]) {
		await page.setViewportSize({ width, height: 940 });
		await page.getByRole('button', { name: 'Home', exact: true }).focus();
		await task.hover();
		await actions.hover();
		const geometry = await task.evaluate((row) => {
			const projectRow = row.closest('.project-group')!.querySelector('.project-row')!;
			const select = row.querySelector<HTMLElement>('.thread-select')!;
			const menu = row.querySelector<HTMLElement>('.row-menu')!;
			const bounds = row.getBoundingClientRect();
			const projectBounds = projectRow.getBoundingClientRect();
			return {
				leftGap: bounds.left - projectBounds.left,
				rightGap: bounds.right - projectBounds.right,
				selectPadding: getComputedStyle(select).paddingLeft,
				rowBackground: getComputedStyle(row).backgroundColor,
				selectBackground: getComputedStyle(select).backgroundColor,
				menuBackground: getComputedStyle(menu).backgroundColor,
				menuOpacity: getComputedStyle(menu).opacity,
			};
		});
		expect(geometry).toMatchObject({
			leftGap: 0,
			rightGap: 0,
			selectPadding: '30px',
			selectBackground: 'rgba(0, 0, 0, 0)',
			menuBackground: 'rgba(0, 0, 0, 0)',
			menuOpacity: '1',
		});
		expect(geometry.rowBackground).not.toBe('rgba(0, 0, 0, 0)');
		await page.locator('.sidebar-panel').screenshot({
			path: `/tmp/freelm-code-review-20261002-1943/sidebar-${width}.png`,
		});
	}
	await actions.click();
	await expect(page.getByRole('menu', { name: 'Actions for Inspect the parser' })).toBeVisible();
	await page.mouse.move(500, 60);
	await expect(task).toHaveClass(/menu-open/);
	await expect(actions).toHaveCSS('opacity', '1');
	await page.keyboard.press('Escape');
	await expect(actions).toBeFocused();
	await expect(page.getByRole('menu', { name: 'Actions for Inspect the parser' })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('content-bearing Code tasks keep their project while empty tasks and Chats remain movable', async ({
	page,
}) => {
	await openCodeFixture(page);
	const existing = page.locator('.thread-row').filter({
		has: page.getByRole('button', { name: 'Inspect the parser', exact: true }),
	});
	await expect(existing).toHaveAttribute('draggable', 'false');
	await existing.hover();
	await page.getByRole('button', { name: 'Actions for Inspect the parser', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Move to project', exact: true })).toBeDisabled();
	await page.keyboard.press('Escape');
	const forbiddenDrag = await existing.evaluate((row) => {
		const data = new DataTransfer();
		const event = new DragEvent('dragstart', {
			bubbles: true,
			cancelable: true,
			dataTransfer: data,
		});
		row.dispatchEvent(event);
		return {
			prevented: event.defaultPrevented,
			payload: data.getData('application/x-freelm-thread'),
		};
	});
	expect(forbiddenDrag).toEqual({ prevented: true, payload: '' });
	const forbiddenDrop = await page.locator('.history-section').evaluate((target) => {
		const data = new DataTransfer();
		data.setData('application/x-freelm-thread', 'project-task');
		const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
		const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
		target.dispatchEvent(over);
		target.dispatchEvent(drop);
		return { overAccepted: over.defaultPrevented, dropAccepted: drop.defaultPrevented };
	});
	expect(forbiddenDrop).toEqual({ overAccepted: false, dropAccepted: false });
	expect(
		await page.evaluate(
			() =>
				(window as any)
					.__sidebarWorkspace()
					.threads.find((thread: { id: string }) => thread.id === 'project-task').projectId,
		),
	).toBe('repository');
	const empty = page.locator('.thread-row').filter({
		has: page.getByRole('button', { name: 'Review an example', exact: true }),
	});
	await expect(empty).toHaveAttribute('draggable', 'true');
	await empty.hover();
	await page.getByRole('button', { name: 'Actions for Review an example', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Move to project', exact: true })).toBeEnabled();
	await page.keyboard.press('Escape');
	await selectConversationMode(page, 'Chat');
	const chat = page.locator('.thread-row').filter({
		has: page.getByRole('button', { name: 'Discuss the example', exact: true }),
	});
	await expect(chat).toHaveAttribute('draggable', 'true');
	await chat.hover();
	await page.getByRole('button', { name: 'Actions for Discuss the example', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Move to project', exact: true })).toBeEnabled();
});
