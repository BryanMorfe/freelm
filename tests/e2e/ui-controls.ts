import { expect, type Locator, type Page } from '@playwright/test';

/** Remote connections belong in Settings; the rail keeps only the Settings shortcut. */
export async function openRemoteSettings(page: Page) {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	await page
		.getByRole('region', { name: 'Settings', exact: true })
		.getByRole('button', { name: 'Remote FreeLM', exact: true })
		.click();
}

/** Exercise the visible menu; ordinary selects and the themed select share this helper. */
export async function chooseOption(
	page: Page,
	control: Locator,
	value: string | { label: string },
) {
	if (await control.evaluate((element) => element.tagName === 'SELECT')) {
		await control.selectOption(value);
		return;
	}
	await control.click();
	if (typeof value !== 'string') {
		await page.getByRole('option', { name: value.label, exact: true }).click();
		return;
	}
	const escaped = await page.evaluate((value) => CSS.escape(value), value);
	await page.locator(`[role="listbox"] [role="option"][data-value="${escaped}"]`).click();
}

export async function expectValue(control: Locator, value: string) {
	if (await control.evaluate((element) => element.tagName === 'SELECT'))
		await expect(control).toHaveValue(value);
	else await expect(control).toHaveAttribute('data-value', value);
}

export async function setChecked(control: Locator, checked = true) {
	if ((await control.getAttribute('role')) === 'switch') {
		if (((await control.getAttribute('aria-checked')) === 'true') !== checked)
			await control.click();
		await expect(control).toHaveAttribute('aria-checked', String(checked));
	} else if (checked) await control.check();
	else await control.uncheck();
}

export async function chooseCustomModel(page: Page, control: Locator, modelId: string) {
	await control.click();
	const more = page.getByRole('button', { name: 'More models', exact: true });
	if (await more.isVisible()) await more.click();
	await page.getByRole('button', { name: 'Use a model ID…', exact: true }).click();
	const search = page.getByRole('combobox', { name: 'Search models', exact: true });
	await search.fill(modelId);
	await search.press('Enter');
}
