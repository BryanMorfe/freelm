import { expect, type Page } from '@playwright/test';

/** Use the same mode chooser as the user; Home retains this selection in media views. */
export async function selectConversationMode(page: Page, mode: 'Chat' | 'Code') {
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	const picker = page.getByRole('combobox', { name: 'Conversation mode', exact: true });
	if (!(await picker.isVisible()))
		await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
	await picker.click();
	await page
		.getByRole('listbox')
		.locator(`[role="option"][data-value="${mode.toLowerCase()}"]`)
		.click();
	await expect(picker).toHaveText(mode);
}
