import { expect, test } from '@playwright/test';
import { pluginFixture } from './helpers/plugin-fixture';

// Disposable bridge only: no real plugin, account, provider or grant is used.
test('plugin library browses real examples, searches, and uses keyboard disclosure without mutations', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const library = await pluginFixture(page, { existing: false });
	await expect(
		library.getByRole('region', { name: 'Included examples', exact: true }).getByRole('button'),
	).toHaveCount(4);
	await page.screenshot({ path: '/tmp/freelm-plugin-browse-after.png' });
	await page.getByRole('button', { name: 'Search plugins', exact: true }).click();
	await page.getByRole('searchbox', { name: 'Find plugins', exact: true }).fill('selected text');
	await expect(
		library.getByRole('button', { name: 'View Selected Text Tools', exact: true }),
	).toBeVisible();
	await expect(library.getByRole('button', { name: 'View Notebook', exact: true })).toHaveCount(0);
	await page.getByRole('searchbox', { name: 'Find plugins', exact: true }).fill('no such extension');
	await expect(
		library.getByRole('heading', { name: 'No matching plugins', exact: true }),
	).toBeVisible();
	await library.getByRole('button', { name: 'Clear search', exact: true }).click();
	const entry = library.getByRole('button', { name: 'View Follow-up Prompts', exact: true });
	await entry.focus();
	await page.keyboard.press('Enter');
	await expect(
		library.getByRole('heading', { name: 'Follow-up Prompts', exact: true }),
	).toBeFocused();
	await expect(
		page
			.getByRole('navigation', { name: 'Plugin library' })
			.getByRole('button', { name: 'Browse', exact: true }),
	).toHaveAttribute('aria-current', 'page');
	const disclosure = library.locator('.plugin-manifest-details summary');
	await expect(disclosure.locator('svg')).toHaveCount(1);
	await disclosure.focus();
	await page.keyboard.press(' ');
	await expect(library.locator('.plugin-manifest-details')).not.toHaveAttribute('open', '');
	await page.keyboard.press('Enter');
	await expect(library.locator('.plugin-manifest-details')).toHaveAttribute('open', '');
	await expect(library.getByRole('heading', { name: 'Authorization', exact: true })).toBeVisible();
	await expect(library.locator('.plugin-manifest-review .settings-group-list')).toHaveCount(6);
	await library.getByRole('heading', { name: 'Follow-up Prompts', exact: true }).focus();
	await page.screenshot({ path: '/tmp/freelm-plugin-detail-after.png' });
	await library.getByRole('button', { name: 'Browse', exact: true }).last().click();
	await expect(entry).toBeFocused();
	await page.getByRole('searchbox', { name: 'Find plugins', exact: true }).fill('follow-up');
	await entry.press('Enter');
	await library.getByRole('button', { name: 'Browse', exact: true }).last().click();
	await expect(entry).toBeFocused();
	await expect(page.getByRole('searchbox', { name: 'Find plugins', exact: true })).toHaveValue(
		'follow-up',
	);
	await expect(library.getByRole('button', { name: 'View Notebook', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__pluginsTest.commands)).toEqual([]);
	expect(await page.evaluate(() => (window as any).__pluginsTest.installs)).toEqual([]);
	expect(errors).toEqual([]);
});

test('included package inspection retries and cancels, and only an explicit reviewed install changes synthetic state', async ({
	page,
}) => {
	const library = await pluginFixture(page, { existing: false });
	await library.getByRole('button', { name: 'View Notebook', exact: true }).click();
	await page.evaluate(() => ((window as any).__pluginsTest.failPrepare = true));
	await library.getByRole('button', { name: 'Review install', exact: true }).click();
	await expect(library.getByRole('alert')).toContainText('Synthetic package inspection failed.');
	await library.getByRole('button', { name: 'Cancel', exact: true }).click();
	await library.getByRole('button', { name: 'Review install', exact: true }).click();
	await expect(library.getByRole('heading', { name: 'Review plugin', exact: true })).toBeVisible();
	await expect(
		library.getByText('Private storage for each account', { exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => (window as any).__pluginsTest.installs)).toEqual([]);
	await library.getByRole('button', { name: 'Back', exact: true }).click();
	await library.getByRole('button', { name: 'Cancel', exact: true }).click();
	await library.getByRole('button', { name: 'Review install', exact: true }).click();
	await expect(library.getByRole('heading', { name: 'Review plugin', exact: true })).toBeVisible();
	await library.getByRole('button', { name: 'Install reviewed plugin', exact: true }).dblclick();
	await expect(
		library.getByRole('switch', { name: 'Enable Notebook', exact: true }),
	).not.toBeChecked();
	expect(await page.evaluate(() => (window as any).__pluginsTest.installs)).toEqual([
		'included-review',
	]);
	expect(await page.evaluate(() => (window as any).__pluginsTest.snapshot.accounts)).toEqual([]);
	await library.getByRole('button', { name: 'Browse', exact: true }).first().click();
	await expect(library.getByRole('button', { name: 'View Notebook', exact: true })).toContainText(
		'Installed',
	);
	await page.screenshot({ path: '/tmp/freelm-plugin-installed-after.png' });
});

test('plugin details preserve grouped rows, disclosure focus and layout at narrow width', async ({
	page,
}) => {
	await page.setViewportSize({ width: 720, height: 940 });
	const library = await pluginFixture(page);
	const disclosure = library.locator('.plugin-manifest-details summary');
	await disclosure.focus();
	await page.keyboard.press('Enter');
	await expect(library.getByText('mail.read, mail.send', { exact: true })).toBeVisible();
	await expect(library.locator('.plugin-manifest-review dl')).toHaveCount(0);
	await library.locator('.plugin-permissions summary').click();
	await expect(
		library.getByRole('switch', { name: 'Allow tool send_mail for Personal', exact: true }),
	).not.toBeChecked();
	await page.screenshot({ path: '/tmp/freelm-plugin-narrow-after.png' });
	const dimensions = await library.evaluate((element) => ({
		width: element.clientWidth,
		scroll: element.scrollWidth,
	}));
	expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
	const sizes = await library
		.locator('summary,button,input,.settings-row-label')
		.evaluateAll((elements) =>
			elements
				.filter((element) => (element as HTMLElement).offsetWidth > 0)
				.map((element) => parseFloat(getComputedStyle(element).fontSize)),
		);
	expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
	expect(await page.evaluate(() => (window as any).__pluginsTest.commands)).toEqual([]);
});

test('Settings shortcut protects unsaved edits and dedicated Plugins persists as a launch destination', async ({
	page,
}) => {
	await pluginFixture(page, { existing: false });
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await settings.getByLabel('System prompt', { exact: true }).fill('Synthetic unsaved settings');
	await settings
		.getByRole('navigation', { name: 'Settings options', exact: true })
		.getByRole('button', { name: 'Plugins', exact: true })
		.click();
	await settings.getByRole('button', { name: 'Open Plugins', exact: true }).click();
	await expect(
		settings.getByText('You have unsaved settings changes.', { exact: true }),
	).toBeVisible();
	await settings.getByRole('button', { name: 'Keep editing', exact: true }).click();
	await settings.getByRole('button', { name: 'System', exact: true }).click();
	await expect(settings.getByLabel('System prompt', { exact: true })).toHaveValue(
		'Synthetic unsaved settings',
	);
	await settings
		.getByRole('navigation', { name: 'Settings options', exact: true })
		.getByRole('button', { name: 'Plugins', exact: true })
		.click();
	await settings.getByRole('button', { name: 'Open Plugins', exact: true }).click();
	await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Plugins', exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('region', { name: 'Plugins', exact: true })).toBeVisible();
	await expect(
		page
			.getByRole('navigation', { name: 'Workspaces', exact: true })
			.getByRole('button', { name: 'Plugins', exact: true }),
	).toHaveAttribute('aria-current', 'page');
});

test('installed shortcuts preserve section context and narrow light rows expose installed status', async ({
	page,
}) => {
	const library = await pluginFixture(page, { selectExisting: false, light: true });
	await page
		.getByRole('region', { name: 'Plugin navigation', exact: true })
		.getByRole('button', { name: 'Example Mail', exact: true })
		.click();
	const navigation = page.getByRole('navigation', { name: 'Plugin library', exact: true });
	await expect(navigation.getByRole('button', { name: 'Installed', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await library.getByRole('button', { name: 'Installed', exact: true }).last().click();
	await expect(
		library.getByRole('button', { name: 'View Example Mail', exact: true }),
	).toBeFocused();
	await page.setViewportSize({ width: 720, height: 940 });
	await expect(library.locator('.plugin-browser-mobile-status')).toBeVisible();
	await expect(
		library.getByRole('heading', { name: 'Installed plugins', exact: true }).first(),
	).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await page.screenshot({ path: '/tmp/freelm-plugin-light-narrow-after.png' });
	const dimensions = await library.evaluate((element) => ({
		width: element.clientWidth,
		scroll: element.scrollWidth,
	}));
	expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
	expect(await page.evaluate(() => (window as any).__pluginsTest.commands)).toEqual([]);
});
