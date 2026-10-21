import { expect, test, type Page } from '@playwright/test';
// Browser plugin is unavailable in this session. Use an isolated renderer fixture
// with actual Chat/CodeMirror components; no user profile or provider is touched.
test.setTimeout(180_000);
async function fixture(page: Page) {
	await page.route('**/plugin-composer-fixture', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<html data-theme="dark"><head><link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div></body></html>',
		}),
	);
	await page.goto('/plugin-composer-fixture');
	await page.evaluate(async () => {
		const refreshPath = '/@react-refresh';
		const refresh = (await import(refreshPath)).default;
		refresh.injectIntoGlobalHook(window);
		(window as any).$RefreshReg$ = () => {};
		(window as any).$RefreshSig$ = () => (type: unknown) => type;
		(window as any).__vite_plugin_react_preamble_installed__ = true;
		const reactPath = '/node_modules/.vite/deps/react.js',
			rootPath = '/node_modules/.vite/deps/react-dom_client.js',
			fixturePath = '/src/stories/composer/PluginSurfacePreview.tsx',
			editorPath = '/src/components/MarkdownComposer.tsx';
		await import(editorPath);
		const [React, ReactDOM, fixture] = await Promise.all([
			import(reactPath),
			import(rootPath),
			import(fixturePath),
		]);
		(ReactDOM.default ?? ReactDOM).createRoot(document.getElementById('root')!).render(
			(React.default ?? React).createElement(fixture.PluginSurfacePreview, {
				onReady: (controller: any) => {
					(window as any).pluginController = controller;
				},
			}),
		);
	});
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText('Reference report', { exact: true })).toBeVisible();
}
test('general placeholder acceptance preserves Undo and stale edits cannot return', async ({
	page,
}) => {
	await fixture(page);
	expect(await page.evaluate(() => (window as any).pluginController.getState())).toMatchObject({
		working: false,
		awaitingInput: false,
		hasCompletedTurn: true,
	});
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.click();
	await editor.press('Tab');
	await expect(editor).toHaveText('What should I work on next?');
	await editor.press('ControlOrMeta+z');
	await expect(editor.locator('.cm-placeholder')).toBeVisible();
	await expect(page.getByText('Tab to use this text', { exact: true })).toHaveCount(0);
	await editor.fill('a user draft');
	const error = await page.evaluate(() => {
		try {
			(window as any).pluginController.execute('preview-plugin', 'composer.setText', {
				text: 'stale result',
				expectedRevision: 1,
			});
			return '';
		} catch (error) {
			return String(error);
		}
	});
	expect(error).toContain('composer changed');
	await expect(editor).toHaveText('a user draft');
});
test('drawer persists through typing and attaches into the real composer', async ({ page }) => {
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('draft with report');
	await expect(page.getByText('Reference report', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Attach', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove reference.txt' })).toBeVisible();
	await page.evaluate(() => (window as any).pluginController.removeOwner('preview-plugin'));
	await expect(page.getByText('Reference report', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove reference.txt' })).toBeVisible();
	await expect(editor).toHaveText('draft with report');
});
test('native completion takes Tab before a plugin contextual keybinding', async ({ page }) => {
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	await editor.fill('/');
	await page.evaluate(() => {
		const controller = (window as any).pluginController;
		controller.execute('preview-plugin', 'commands.register', {
			id: 'overwrite',
			title: 'Should not run',
			action: {
				type: 'composer.setText',
				text: 'wrong',
				expectedRevision: controller.getState().revision,
			},
		});
		controller.execute('preview-plugin', 'keybindings.register', {
			id: 'any-tab',
			key: 'Tab',
			command: 'overwrite',
		});
	});
	await expect(page.getByRole('option', { name: /Goal/ })).toBeVisible();
	await editor.press('Tab');
	await expect(editor).not.toHaveText('wrong');
	await expect(page.getByRole('listbox', { name: 'Composer suggestions' })).toHaveCount(0);
});

test('long wrapped plugin placeholder keeps a first-line caret', async ({ page }, testInfo) => {
	await fixture(page);
	const editor = page.getByRole('textbox', { name: 'Message', exact: true });
	const suggestion =
		'Please review the implementation in detail, explain the tradeoffs, and suggest the next useful improvement. Include the important edge cases and give me a concrete plan that I can follow to validate the changes on both macOS and Linux without losing existing data.';
	await page.evaluate((text) => {
		const controller = (window as any).pluginController;
		controller.execute('preview-plugin', 'composer.placeholder.update', {
			id: 'preview-hint',
			text,
		});
		controller.execute('preview-plugin', 'commands.register', {
			id: 'accept',
			title: 'Use text',
			action: { type: 'composer.setText', text, expectedRevision: controller.getState().revision },
		});
	}, suggestion);
	const hint = page.getByRole('button', { name: 'Tab to use this text', exact: true });
	await expect(hint.locator('svg[aria-hidden="true"]')).toBeVisible();
	// Keep the native caret visible while capturing. Its rendered height has no
	// DOM rectangle, so verify the actual pixels rather than a particular CSS fix.
	await page.addStyleTag({ content: '.cm-content{caret-animation:manual !important}' });
	for (const theme of ['dark', 'light'])
		for (const width of [800, 400]) {
			await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
			await page.locator('#root > div').evaluate((el, value) => {
				(el as HTMLElement).style.width = `${value}px`;
			}, width);
			await editor.click({ position: { x: 8, y: 8 } });
			await editor.press('ArrowLeft');
			const geometry = await editor.evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element.querySelector('.cm-placeholder')!);
				const lines = Array.from(range.getClientRects(), (r) => ({
					left: r.left,
					top: r.top,
					bottom: r.bottom,
				}));
				const box = element.closest('.composer')!.getBoundingClientRect();
				return {
					lineHeight: parseFloat(getComputedStyle(element).lineHeight),
					caretColor: getComputedStyle(element).caretColor,
					x: lines[0].left - box.x,
					top: lines[0].top - box.y,
					bottom: lines.at(-1)!.bottom - box.y,
					lines: lines.length,
					editorHeight: element.getBoundingClientRect().height,
				};
			});
			expect(geometry.lines).toBeGreaterThan(1);
			expect(geometry.editorHeight).toBeGreaterThan(geometry.lineHeight * 2);
			const screenshot = await page
				.locator('.composer')
				.last()
				.screenshot({ path: `/tmp/freelm-caret-fixed-${theme}-${width}.png`, caret: 'initial' });
			const caretHeight = await page.evaluate(
				async ({ bytes, geometry }) => {
					const image = await createImageBitmap(
						new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
					);
					const canvas = document.createElement('canvas');
					canvas.width = image.width;
					canvas.height = image.height;
					const context = canvas.getContext('2d')!;
					context.drawImage(image, 0, 0);
					const pixels = context.getImageData(0, 0, image.width, image.height).data;
					context.fillStyle = geometry.caretColor;
					context.fillRect(0, 0, 1, 1);
					const color = context.getImageData(0, 0, 1, 1).data;
					let longest = 0;
					for (let x = Math.floor(geometry.x) - 1; x <= Math.ceil(geometry.x) + 1; x++) {
						let run = 0;
						for (
							let y = Math.max(0, Math.floor(geometry.top - geometry.lineHeight));
							y < Math.min(image.height, Math.ceil(geometry.bottom + geometry.lineHeight));
							y++
						) {
							const offset = (y * image.width + x) * 4;
							const match = [0, 1, 2].every((c) => Math.abs(pixels[offset + c] - color[c]) < 25);
							run = match ? run + 1 : 0;
							longest = Math.max(longest, run);
						}
					}
					return longest;
				},
				{ bytes: [...screenshot], geometry },
			);
			console.log(`Caret ${theme} ${width}px`, { ...geometry, caretHeight });
			await testInfo.attach(`caret-${theme}-${width}`, {
				body: JSON.stringify({ ...geometry, caretHeight }),
				contentType: 'application/json',
			});
			expect(caretHeight).toBeGreaterThan(8);
			expect(caretHeight).toBeLessThanOrEqual(geometry.lineHeight + 2);
		}
	await editor.press('Tab');
	await expect(editor).toHaveText(suggestion);
	await editor.press('ControlOrMeta+z');
	await expect(editor.locator('.cm-placeholder')).toBeVisible();
	await expect(hint).toHaveCount(0);
	await editor.fill('A different draft');
	await editor.press('ControlOrMeta+a');
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('A different draft');
	await editor.press('Backspace');
	await expect(editor.locator('.cm-placeholder')).toBeVisible();
	await expect(hint).toHaveCount(0);
});
