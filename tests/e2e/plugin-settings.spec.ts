import { expect, test, type Page } from '@playwright/test';
import { pluginFixture, manifest } from './helpers/plugin-fixture';
async function fixture(page: Page, existing = true, pending = false) {
	return pluginFixture(page, { existing, pending });
}

test('review manifest identity and scopes before installation, then enable and connect a labeled account', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await fixture(page, false);
	await settings.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Manifest JSON' }).fill(JSON.stringify(manifest));
	await settings.getByRole('button', { name: 'Review manifest' }).click();
	await expect(settings.getByText('desktop-client', { exact: true })).toBeVisible();
	await expect(settings.getByText('mail.read, mail.send', { exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.commands.length))
		.toBe(0);
	await settings.getByRole('button', { name: 'Install reviewed plugin' }).click();
	await expect(settings.getByRole('switch', { name: 'Enable Example Mail' })).not.toBeChecked();
	await settings.getByRole('switch', { name: 'Enable Example Mail' }).click();
	await settings.getByRole('button', { name: 'Add account', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Account label' }).fill('Work');
	await settings.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(settings.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
	await settings.locator('.plugin-permissions summary').click();
	for (const label of [
		'Allow Chat for Work',
		'Allow Code for Work',
		'Allow Nova for Work',
		'Allow tool search_mail for Work',
		'Allow tool send_mail for Work',
		'Allow remote clients for Work',
	])
		await expect(settings.getByRole('switch', { name: label, exact: true })).not.toBeChecked();
	await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('account permission grants use exact tools and bots, survive reopening, and keep new tools off', async ({
	page,
}) => {
	const settings = await fixture(page);
	await settings.locator('.plugin-permissions summary').click();
	await expect(settings.getByText(/without a separate prompt for each call/)).toBeVisible();
	await settings.getByRole('switch', { name: 'Allow Nova for Personal', exact: true }).click();
	await settings
		.getByRole('switch', { name: 'Allow tool search_mail for Personal', exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.snapshot.accounts[0].access))
		.toEqual({
			chat: false,
			code: false,
			botIds: ['nova'],
			tools: ['search_mail'],
			allowRemote: false,
		});
	await settings.getByRole('button', { name: 'Discover tools', exact: true }).click();
	await expect(
		settings.getByRole('switch', { name: 'Allow tool archive_mail for Personal' }),
	).not.toBeChecked();
	await page
		.getByRole('navigation', { name: 'Workspaces', exact: true })
		.getByRole('button', { name: 'Home', exact: true })
		.click();
	await page
		.getByRole('navigation', { name: 'Workspaces', exact: true })
		.getByRole('button', { name: 'Plugins', exact: true })
		.click();
	await settings.getByRole('button', { name: 'View Example Mail', exact: true }).click();
	await settings.locator('.plugin-permissions summary').click();
	await expect(
		settings.getByRole('switch', { name: 'Allow tool search_mail for Personal', exact: true }),
	).toBeChecked();
	await expect(
		settings.getByRole('switch', { name: 'Allow Nova for Personal', exact: true }),
	).toBeChecked();
});

test('cancel OAuth, surface service failures, and disconnect without losing other settings', async ({
	page,
}) => {
	const settings = await fixture(page, true, true);
	await settings.getByRole('button', { name: 'Reconnect', exact: true }).click();
	await expect(settings.getByText('Complete sign-in in your browser.')).toBeVisible();
	await settings.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Sign-in cancelled.');
	await page.evaluate(() => {
		(window as any).__pluginsTest.fail = true;
	});
	await settings.getByRole('button', { name: 'Discover tools', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Service unavailable.');
	await settings.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(
		settings.getByRole('heading', { name: 'Personal', exact: true, level: 4 }),
	).toHaveCount(0);
	await settings.getByRole('button', { name: 'Remove plugin', exact: true }).click();
	await expect(settings.getByRole('alert')).toContainText('Remove Example Mail');
	await settings.getByRole('button', { name: 'Remove and disconnect' }).click();
	await page
		.getByRole('navigation', { name: 'Plugin library' })
		.getByRole('button', { name: 'Installed', exact: true })
		.click();
	await expect(settings.getByText('No plugins installed')).toBeVisible();
});

test('invalid manifests remain uninstalled and browser-only settings explain desktop requirement', async ({
	page,
}) => {
	const settings = await fixture(page, false);
	await settings.getByRole('button', { name: 'Install plugin', exact: true }).click();
	await settings.getByRole('textbox', { name: 'Manifest JSON' }).fill('{"manifestVersion":1}');
	await settings.getByRole('button', { name: 'Review manifest' }).click();
	await expect(settings.getByRole('alert')).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__pluginsTest.commands.length))
		.toBe(0);
	await page
		.getByRole('navigation', { name: 'Workspaces', exact: true })
		.getByRole('button', { name: 'Home', exact: true })
		.click();
	await page.evaluate(() => {
		delete (window as any).desktop.pluginSnapshot;
	});
	await page
		.getByRole('navigation', { name: 'Workspaces', exact: true })
		.getByRole('button', { name: 'Plugins', exact: true })
		.click();
	await expect(settings.getByRole('heading', { name: 'Desktop app required' })).toBeVisible();
	await expect(
		settings.getByRole('button', { name: 'Install plugin', exact: true }),
	).toBeDisabled();
});
