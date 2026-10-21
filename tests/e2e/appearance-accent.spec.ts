import { expect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState } from '../../src/types';
import { chooseOption } from './ui-controls';

test.setTimeout(180_000);
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

const title = 'Accent appearance examples';
const choices = [
	'default',
	'blue',
	'green',
	'yellow',
	'pink',
	'orange',
	'purple',
	'white',
	'custom',
];

// Browser plugin unavailable: use the real renderer and private desktop bridge.
// The Node-side fixture survives document reloads without reading any real
// profile, storage path, microphone, or inference service.
async function fixture(page: Page, richText = false) {
	const state = initialState();
	delete state.appearance;
	const connection = state.connections[0];
	connection.baseUrl = 'http://accent-fixture.invalid/v1';
	connection.models.chat = 'accent-chat';
	connection.catalog = [
		{
			id: 'accent-chat',
			name: 'Chat fixture',
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
	const image = `data:image/svg+xml;base64,${Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="170"><rect width="240" height="170" fill="#28546c"/><circle cx="120" cy="85" r="45" fill="#80b8ce"/></svg>',
	).toString('base64')}`;
	const now = Date.now() - 60_000;
	state.threads = [
		{
			id: 'accent-thread',
			kind: 'chat',
			title,
			titleSource: 'manual',
			connectionId: connection.id,
			model: 'accent-chat',
			thinkingMode: 'low',
			createdAt: now,
			updatedAt: now + 2000,
			messages: [
				{
					id: 'accent-user',
					role: 'user',
					content: richText
						? 'Can you explain this sample image?\n\n> This quoted source stays readable.\n\n```text\nA code example that remains readable.\n```'
						: 'Can you explain this sample image?',
					createdAt: now,
					attachments: [{ name: 'Sample image.svg', type: 'image/svg+xml', dataUrl: image }],
				},
				{
					id: 'accent-answer',
					role: 'assistant',
					content: 'I can help you analyze the sample image.',
					createdAt: now + 1000,
					completedAt: now + 2000,
				},
			],
		},
	];
	let current = structuredClone(state),
		revision = 0;
	await page.exposeFunction('__accentLoad', () => ({
		state: structuredClone(current),
		revision: String(revision),
	}));
	await page.exposeFunction(
		'__accentSave',
		(_workspace: string, _revision: string, next: AppState) => {
			current = structuredClone(next);
			return { revision: String(++revision) };
		},
	);
	await page.addInitScript(() => {
		(window as any).desktop = {
			platform: 'linux',
			workspaceLoad: () => (window as any).__accentLoad(),
			workspaceSave: (id: string, revision: string, next: AppState) =>
				(window as any).__accentSave(id, revision, next),
			storageInfo: async () => ({ secure: false, location: 'Private appearance fixture' }),
			onPrepareClose: () => () => {},
			onToolApproval: () => () => {},
			onChunk: () => () => {},
			toolCancel: async () => {},
			cancel: async () => {},
			instanceStatus: async () => ({
				host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
				instances: [],
			}),
			request: async () => {
				throw new Error('An appearance test must not request inference.');
			},
		};
	});
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await openThread(page);
	return { saved: () => structuredClone(current), image };
}

async function openThread(page: Page) {
	await page.getByRole('button', { name: title, exact: true }).click();
	await expect(page.locator('[data-message-id="accent-answer"]')).toContainText('I can help you');
	await page.getByLabel('Message', { exact: true }).fill('A draft to show the Send button.');
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}
async function appearance(page: Page) {
	await page.getByRole('button', { name: 'Personal workspace settings', exact: true }).click();
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await expect(settings.getByRole('combobox', { name: 'Accent color', exact: true })).toBeVisible();
	return settings;
}
async function saveAndReturn(settings: Locator) {
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(settings).toHaveCount(0);
}
async function colors(page: Page) {
	return page.evaluate(() => {
		const bubble = getComputedStyle(
			document.querySelector('[data-message-id="accent-user"] .message-bubble')!,
		);
		const send = getComputedStyle(document.querySelector('[aria-label="Send message"]')!);
		const assistant = getComputedStyle(
			document.querySelector('[data-message-id="accent-answer"] .message-content p')!,
		);
		return {
			bubble: bubble.backgroundColor,
			bubbleText: bubble.color,
			primary: send.backgroundColor,
			onPrimary: send.color,
			assistant: assistant.color,
			semanticAccent: bubble.getPropertyValue('--accent').trim(),
		};
	});
}
function rgb(value: string): number[] {
	const numbers = value.match(/[\d.]+/g)?.map(Number) || [];
	if (value.startsWith('color(srgb')) return numbers.slice(0, 3).map((channel) => channel * 255);
	expect(value).toMatch(/^rgba?\(/);
	return numbers.slice(0, 3);
}
function contrast(background: string, foreground: string) {
	const luminance = (color: string) =>
		rgb(color).reduce((sum, channel, index) => {
			const s = channel / 255,
				linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			return sum + linear * [0.2126, 0.7152, 0.0722][index];
		}, 0);
	const a = luminance(background),
		b = luminance(foreground);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function hue(color: string) {
	const [r, g, b] = rgb(color).map((channel) => channel / 255);
	const maximum = Math.max(r, g, b),
		minimum = Math.min(r, g, b),
		delta = maximum - minimum;
	if (!delta) return 0;
	const sector =
		maximum === r
			? ((g - b) / delta) % 6
			: maximum === g
				? (b - r) / delta + 2
				: (r - g) / delta + 4;
	return (sector * 60 + 360) % 360;
}
async function expectReadable(page: Page, assistantColor?: string) {
	const actual = await colors(page);
	expect(contrast(actual.bubble, actual.bubbleText)).toBeGreaterThanOrEqual(4.5);
	expect(contrast(actual.primary, actual.onPrimary)).toBeGreaterThanOrEqual(4.5);
	if (assistantColor) expect(actual.assistant).toBe(assistantColor);
	return actual;
}
async function expectPopupBounds(page: Page) {
	const popup = page.getByRole('listbox');
	await expect(popup).toBeVisible();
	const bounds = (await popup.boundingBox())!,
		viewport = page.viewportSize()!;
	expect(bounds.x).toBeGreaterThanOrEqual(8);
	expect(bounds.y).toBeGreaterThanOrEqual(8);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 7);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 7);
}
async function expectExteriorAttachments(page: Page, image: string) {
	const message = page.locator('[data-message-id="accent-user"]');
	await expect(message.locator('img')).toHaveAttribute('src', image);
	await expect(message.locator('.message-bubble img, .message-bubble button')).toHaveCount(0);
	await expect(
		message.getByRole('button', { name: 'Branch conversation', exact: true }),
	).toHaveCount(0);
	const result = await message.evaluate((element) => {
		const bubble = element.querySelector('.message-bubble')!,
			attachments = element.querySelector('.message-attachments')!,
			footer = element.querySelector('.message-footer')!;
		return {
			transparent: getComputedStyle(element).backgroundColor,
			siblingAttachments: attachments.parentElement === element,
			siblingActions: footer.parentElement === element,
			attachmentBottom: attachments.getBoundingClientRect().bottom,
			bubbleTop: bubble.getBoundingClientRect().top,
			bubbleBottom: bubble.getBoundingClientRect().bottom,
			footerTop: footer.getBoundingClientRect().top,
		};
	});
	expect(result.transparent).toBe('rgba(0, 0, 0, 0)');
	expect(result.siblingAttachments).toBe(true);
	expect(result.siblingActions).toBe(true);
	expect(result.attachmentBottom).toBeLessThanOrEqual(result.bubbleTop);
	expect(result.footerTop).toBeGreaterThanOrEqual(result.bubbleBottom);
}

test('accent selector preserves defaults and has swatches, padded chevrons, keyboard selection and bounded desktop/narrow menus', async ({
	page,
}) => {
	const control = await fixture(page);
	const original = await colors(page);
	expect(rgb(original.bubble)).toEqual([47, 47, 47]);
	expect(rgb(original.primary)).toEqual([241, 241, 241]);
	const settings = await appearance(page);
	const accent = settings.getByRole('combobox', { name: 'Accent color', exact: true });
	await expect(accent).toHaveAttribute('data-value', 'default');
	await expect(accent.locator('.select-swatch')).toBeVisible();
	const clearance = await accent.evaluate((element) => {
		const trigger = element.getBoundingClientRect(),
			label = element.querySelector(':scope > span')!.getBoundingClientRect(),
			chevron = element.querySelector('.lucide-chevron-down')!.getBoundingClientRect();
		return { right: trigger.right - chevron.right, gap: chevron.left - label.right };
	});
	expect(clearance.right).toBeGreaterThanOrEqual(10);
	expect(clearance.gap).toBeGreaterThanOrEqual(12);
	await accent.click();
	await expectPopupBounds(page);
	expect(
		await page
			.getByRole('option')
			.evaluateAll((options) => options.map((option) => option.getAttribute('data-value'))),
	).toEqual(choices);
	await expect(page.getByRole('listbox').locator('.select-swatch')).toHaveCount(9);
	await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
		'data-value',
		'default',
	);
	await expect(page.getByRole('listbox').locator('.lucide-check')).toHaveCount(1);
	await accent.press('Escape');
	await expect(accent).toBeFocused();
	await accent.press('ArrowDown');
	await accent.press('ArrowDown');
	await accent.press('Enter');
	await expect(accent).toHaveAttribute('data-value', 'blue');
	expect(control.saved().appearance?.accent || 'default').toBe('default');
	await page.setViewportSize({ width: 390, height: 844 });
	await accent.click();
	await expectPopupBounds(page);
	await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
		'data-value',
		'blue',
	);
	await page.screenshot({ path: '/tmp/freelm-appearance-accent-narrow.png', fullPage: false });
	await accent.press('Escape');
	await page.setViewportSize({ width: 1440, height: 940 });
	await chooseOption(page, accent, 'default');
	await saveAndReturn(settings);
	expect(await colors(page)).toEqual(original);
	expect(control.saved().appearance?.accent).toBe('default');
});

test('saved blue accent colors user bubbles and Send, persists across reload, and keeps yellow/white readable without recoloring assistant text', async ({
	page,
}) => {
	const control = await fixture(page);
	const original = await colors(page);
	let settings = await appearance(page);
	let accent = settings.getByRole('combobox', { name: 'Accent color', exact: true });
	await chooseOption(page, accent, 'blue');
	await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await expect(settings.getByRole('group', { name: 'Accent preview', exact: true })).toBeVisible();
	await accent.click();
	await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
		'data-value',
		'blue',
	);
	await page.screenshot({ path: '/tmp/freelm-appearance-accent.png', fullPage: false });
	await accent.press('Escape');
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	const blue = await expectReadable(page, original.assistant);
	expect(blue.semanticAccent).toBe(original.semanticAccent);
	expect(blue.bubble).not.toBe(original.bubble);
	expect(blue.primary).not.toBe(original.primary);
	expect(hue(blue.bubble)).toBeGreaterThan(190);
	expect(hue(blue.bubble)).toBeLessThan(260);
	expect(Math.abs(hue(blue.bubble) - hue(blue.primary))).toBeLessThan(3);
	await expectExteriorAttachments(page, control.image);
	await page.screenshot({ path: '/tmp/freelm-accent-chat.png', fullPage: false });
	await page.reload();
	await openThread(page);
	expect(control.saved().appearance?.accent).toBe('blue');
	expect(await colors(page)).toEqual(blue);
	for (const value of ['yellow', 'white']) {
		settings = await appearance(page);
		accent = settings.getByRole('combobox', { name: 'Accent color', exact: true });
		await chooseOption(page, accent, value);
		await saveAndReturn(settings);
		const actual = await expectReadable(page, original.assistant);
		expect(actual.semanticAccent).toBe(original.semanticAccent);
		expect(control.saved().appearance?.accent).toBe(value);
	}
});

test('custom hex normalizes, invalid drafts block Save with an error, and only the valid color survives reload', async ({
	page,
}) => {
	const control = await fixture(page);
	const original = await colors(page);
	let settings = await appearance(page);
	let accent = settings.getByRole('combobox', { name: 'Accent color', exact: true });
	await chooseOption(page, accent, 'custom');
	let hex = settings.getByRole('textbox', { name: 'Custom accent color', exact: true });
	const picker = settings.getByLabel('Choose custom accent color', { exact: true });
	await expect(picker).toHaveAttribute('type', 'color');
	await hex.fill('#abc');
	await expect(picker).toHaveValue('#aabbcc');
	await saveAndReturn(settings);
	expect(control.saved().appearance).toEqual({ accent: 'custom', customAccent: '#aabbcc' });
	await expectReadable(page, original.assistant);
	settings = await appearance(page);
	hex = settings.getByRole('textbox', { name: 'Custom accent color', exact: true });
	await expect(hex).toHaveValue('#aabbcc');
	await hex.fill('#12xz');
	await expect(hex).toHaveAttribute('aria-invalid', 'true');
	await expect(settings.getByRole('alert')).toContainText('Enter a hex color');
	await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
	expect(control.saved().appearance).toEqual({ accent: 'custom', customAccent: '#aabbcc' });
	await settings.getByRole('button', { name: 'Back to workspace', exact: true }).click();
	await expect(
		settings.getByRole('button', { name: 'Save and go back', exact: true }),
	).toBeDisabled();
	await settings.getByRole('button', { name: 'Discard changes', exact: true }).click();
	await page.reload();
	await openThread(page);
	settings = await appearance(page);
	accent = settings.getByRole('combobox', { name: 'Accent color', exact: true });
	await expect(accent).toHaveAttribute('data-value', 'custom');
	await expect(
		settings.getByRole('textbox', { name: 'Custom accent color', exact: true }),
	).toHaveValue('#aabbcc');
	await expect(settings.getByLabel('Choose custom accent color', { exact: true })).toHaveValue(
		'#aabbcc',
	);
	await expect(settings.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
	expect(control.saved().appearance).toEqual({ accent: 'custom', customAccent: '#aabbcc' });
	const currentHex = settings.getByRole('textbox', { name: 'Custom accent color', exact: true });
	await currentHex.fill('#777777');
	const save = settings.getByRole('button', { name: 'Save settings', exact: true });
	await save.click();
	await expect(settings.getByText('Settings saved', { exact: true })).toBeVisible();
	await page.mouse.move(10, 10);
	const buttonColors = (button: Element) => {
		const style = getComputedStyle(button);
		return {
			background: style.backgroundColor,
			foreground: style.color,
			filter: style.filter,
			opacity: style.opacity,
		};
	};
	const normal = await save.evaluate(buttonColors);
	await save.hover();
	const hovered = await save.evaluate(buttonColors);
	expect(hovered).toEqual(normal);
	expect(hovered.filter).toBe('none');
	expect(contrast(hovered.background, hovered.foreground)).toBeGreaterThanOrEqual(4.5);
	expect(control.saved().appearance).toEqual({ accent: 'custom', customAccent: '#777777' });
});

test('quoted text and fenced code remain readable inside Light blue and Dark white user bubbles', async ({
	page,
}) => {
	await fixture(page, true);
	for (const [theme, accentColor] of [
		['Light', 'blue'],
		['Dark', 'white'],
	] as const) {
		const settings = await appearance(page);
		await settings.getByRole('radio', { name: theme, exact: true }).click();
		await chooseOption(
			page,
			settings.getByRole('combobox', { name: 'Accent color', exact: true }),
			accentColor,
		);
		await saveAndReturn(settings);
		const current = await expectReadable(page);
		const markdown = await page.locator('[data-message-id="accent-user"]').evaluate((element) => {
			const quote = getComputedStyle(element.querySelector('blockquote p')!);
			const code = getComputedStyle(element.querySelector('.code-block pre code')!);
			const block = getComputedStyle(element.querySelector('.code-block')!);
			return { quote: quote.color, code: code.color, codeBackground: block.backgroundColor };
		});
		expect(markdown.quote).toBe(current.bubbleText);
		expect(contrast(current.bubble, markdown.quote)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(markdown.codeBackground, markdown.code)).toBeGreaterThanOrEqual(4.5);
		expect(markdown.code).toBe(current.assistant);
	}
});
