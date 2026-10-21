import { expect as playwrightExpect, test, type Locator, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import { defaultToolSettings } from '../../src/lib/tool-settings';
import type { AppState, Message, Thread } from '../../src/types';
// This suite validates behavior, while native profiling measures editor latency.
// Chrome protocol calls on this host can take several seconds independently of
// renderer work, so allow two persisted-state reads before declaring a mismatch.
const expect = playwrightExpect.configure({ timeout: 15_000 });
test.setTimeout(300_000);
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (entry) => {
		if (entry.type() === 'error') errors.push(entry.text());
	});
});
test.afterEach(({ page }) => {
	expect(browserErrors.get(page)).toEqual([]);
});

function composer(page: Page): Locator {
	return page.getByRole('textbox', { name: 'Message', exact: true });
}
async function expectDraft(page: Page, content: string, scope = 'composer-thread') {
	await expect
		.poll(() =>
			page.evaluate(
				(id) => (window as any).__composerFixture.state().chatDrafts?.[id]?.content || '',
				scope,
			),
		)
		.toBe(content);
}
async function paste(editor: Locator, plain: string, html = '') {
	await editor.evaluate(
		(element, clipboard) => {
			const data = new DataTransfer();
			data.setData('text/plain', clipboard.plain);
			if (clipboard.html) data.setData('text/html', clipboard.html);
			element.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
			);
		},
		{ plain, html },
	);
}
async function requestCount(page: Page) {
	return page.evaluate(() => (window as any).__composerFixture.requests.length);
}
async function lastUserInput(page: Page) {
	return page.evaluate(() => {
		const request = (window as any).__composerFixture.requests
			.filter((entry: any) => entry.path.includes('/responses'))
			.at(-1);
		const message = request?.body.input.filter((entry: any) => entry.role === 'user').at(-1);
		return message?.content.find((entry: any) => entry.type === 'input_text')?.text;
	});
}

// Exercise the real renderer against a private in-memory bridge. No profile,
// microphone hardware, filesystem execution, or external provider is accessed.
async function fixture(page: Page, dictation = false, holdEditor = false) {
	let releaseEditor = () => {};
	if (holdEditor) {
		const loaded = new Promise<void>((resolve) => (releaseEditor = resolve));
		await page.route('**/*MarkdownComposer*', async (route) => {
			await loaded;
			if (!page.isClosed()) await route.continue();
		});
	}
	const state = initialState();
	const connection = state.connections[0];
	connection.baseUrl = 'http://composer-fixture.invalid/v1';
	connection.models.chat = 'chat-fixture';
	connection.catalog = [
		{
			id: 'chat-fixture',
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
		{
			id: 'asr-fixture',
			name: 'ASR fixture',
			enabled: true,
			tasks: ['transcription'],
			inputModalities: ['audio'],
			outputModalities: ['text'],
			thinkingModes: [],
		},
	];
	state.memorySettings = { savedMemories: false, referenceHistory: false };
	state.toolSettings = { ...defaultToolSettings(), enabled: false };
	state.dictation = {
		enabled: dictation,
		connectionId: connection.id,
		model: dictation ? 'asr-fixture' : '',
	};
	const now = Date.now() - 600_000;
	const messages: Message[] = [
		{ id: 'first-user', role: 'user', content: 'Original question', createdAt: now },
		{
			id: 'first-answer',
			role: 'assistant',
			content: 'Original answer with $x^2$\n\n```javascript\nconst answer = 42;\n```',
			createdAt: now + 1000,
			completedAt: now + 2000,
		},
		{ id: 'second-user', role: 'user', content: 'Latest question', createdAt: now + 3000 },
		{
			id: 'second-answer',
			role: 'assistant',
			content: 'Latest answer',
			createdAt: now + 4000,
			completedAt: now + 5000,
		},
	];
	const thread: Thread = {
		id: 'composer-thread',
		kind: 'chat',
		title: 'Composer examples',
		titleSource: 'manual',
		connectionId: connection.id,
		model: 'chat-fixture',
		thinkingMode: 'low',
		createdAt: now,
		updatedAt: now + 5000,
		messages,
	};
	state.threads = [
		thread,
		{
			...thread,
			id: 'other-thread',
			title: 'Other conversation',
			messages: [],
			createdAt: now + 10_000,
			updatedAt: now + 10_000,
		},
	];
	await page.addInitScript(
		({ serialized }) => {
			let current: AppState = JSON.parse(sessionStorage.getItem('composer-state') || serialized),
				revision = 0;
			const listeners = new Set<(event: { id: string; text: string }) => void>();
			const control: any = { requests: [], state: () => current, stoppedTracks: 0 };
			(window as any).__composerFixture = control;
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						control.clipboardText = text;
					},
					readText: async () => control.clipboardText || '',
				},
			});
			Object.defineProperty(navigator, 'mediaDevices', {
				configurable: true,
				value: {
					getUserMedia: async () => ({
						getTracks: () => [{ stop: () => control.stoppedTracks++ }],
					}),
				},
			});
			class FakeRecorder {
				static isTypeSupported() {
					return true;
				}
				state = 'inactive';
				mimeType = 'audio/webm';
				ondataavailable?: (event: any) => void;
				onstop?: () => void;
				onerror?: () => void;
				start() {
					if (control.recordingError) throw new Error('Fixture recorder error');
					this.state = 'recording';
				}
				stop() {
					this.state = 'inactive';
					this.ondataavailable?.({ data: new Blob(['audio fixture'], { type: 'audio/webm' }) });
					this.onstop?.();
				}
			}
			(window as any).MediaRecorder = FakeRecorder;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({
					state: structuredClone(current),
					revision: String(revision),
				}),
				workspaceSave: async (_id: string, _revision: string, next: AppState) => {
					current = structuredClone(next);
					sessionStorage.setItem('composer-state', JSON.stringify(current));
					return { revision: String(++revision) };
				},
				storageInfo: async () => ({ secure: false, location: 'Private composer fixture' }),
				onPrepareClose: () => () => {},
				onToolApproval: () => () => {},
				toolCancel: async () => {},
				cancel: async () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				onChunk: (listener: any) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				request: async (request: any) => {
					control.requests.push(request);
					if (request.path.includes('/audio/transcriptions'))
						return {
							status: 200,
							contentType: 'application/json',
							encoding: 'text',
							body: JSON.stringify({ text: 'A dictated message' }),
						};
					const answer = `Generated answer ${control.requests.length}`;
					for (const data of [
						{ type: 'response.output_text.delta', delta: answer },
						{ type: 'response.completed', response: { output_text: answer } },
					])
						for (const listener of listeners)
							listener({ id: request.id, text: `data: ${JSON.stringify(data)}\n\n` });
					return { status: 200, contentType: 'text/event-stream', encoding: 'text', body: '' };
				},
			};
		},
		{ serialized: JSON.stringify(state) },
	);
	await page.goto('/');
	await expect(page).toHaveTitle('FreeLM');
	await expect(page).toHaveURL(new URL('/', test.info().project.use.baseURL).href);
	await expect(page.locator('vite-error-overlay')).toHaveCount(0);
	if (!holdEditor) await expect(composer(page)).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: thread.title, exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(4);
	return releaseEditor;
}

test('drafts survive navigation; Up restores the previous prompt; rich and large paste become useful content', async ({
	page,
}) => {
	await fixture(page);
	const editor = composer(page);
	await editor.fill('Keep this draft');
	// Navigation flushes the latest draft even inside the debounce interval.
	await page.getByRole('button', { name: 'Other conversation', exact: true }).click();
	await editor.fill('Another draft');
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expect(editor).toHaveText('Keep this draft');
	await editor.fill('');
	await editor.press('ArrowUp');
	await expectDraft(page, 'Latest question');
	await editor.fill('');
	await paste(
		editor,
		'Plan\nBold\nOne',
		'<h2>Plan</h2><p><strong>Bold</strong></p><ul><li>One</li></ul><script>bad()</script>',
	);
	await expectDraft(page, '## Plan\n\n**Bold**\n\n- One');
	await editor.fill('Read this');
	await paste(editor, 'Detailed material. '.repeat(1000));
	await expectDraft(page, 'Read this');
	await expect(page.locator('.attachment-preview')).toContainText('Pasted text.txt');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.assistant').last()).toContainText('Generated answer');
	await expect
		.poll(() => page.evaluate(() => JSON.stringify((window as any).__composerFixture.requests)))
		.toContain('Detailed material.');
});

test('dictation is gated by configuration; cancel, navigation and recorder failure release the microphone', async ({
	page,
}) => {
	await fixture(page, true);
	const editor = composer(page);
	await editor.fill('Keep my words');
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
	await expectDraft(page, 'Keep my words');
	await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Other conversation', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerFixture.requests.length))
		.toBe(0);
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerFixture.stoppedTracks))
		.toBeGreaterThan(1);
	await page.evaluate(() => {
		(window as any).__composerFixture.recordingError = true;
	});
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Fixture recorder error');
	await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerFixture.stoppedTracks))
		.toBeGreaterThan(2);
});

test('inline and display equations render in place and reveal editable Markdown without a preview button; message code still copies', async ({
	page,
}) => {
	test.setTimeout(360_000);
	await fixture(page);
	await expect(page.locator('[data-message-id="first-answer"] .katex')).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.locator('.code-block .hljs-keyword')).toContainText('const');
	await page.getByRole('button', { name: 'Copy code', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe('const answer = 42;');
	const editor = composer(page);
	await editor.fill('Solve \\(x^2+1=0\\) now');
	await expectDraft(page, 'Solve \\(x^2+1=0\\) now');
	const equation = page.locator('.cm-composer-math');
	await expect(equation.locator('.katex')).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Preview formatting and math', exact: true }),
	).toHaveCount(0);
	await expect(page.locator('.composer-math-preview')).toHaveCount(0);
	await equation.click({ timeout: 10_000 });
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('x^2+1=0');
	await page.keyboard.insertText('x^3+1=0');
	await editor.press('ControlOrMeta+End');
	await expectDraft(page, 'Solve \\(x^3+1=0\\) now');
	await expect(equation.locator('.katex')).toBeVisible();
	await page.screenshot({ path: '/tmp/freelm-smart-composer-math.png', animations: 'disabled' });
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect.poll(() => lastUserInput(page)).toBe('Solve \\(x^3+1=0\\) now');
	await editor.fill('Equation:\n\n\\[\nx^2+1=0\n\\]\n\nEnd');
	await expectDraft(page, 'Equation:\n\n\\[\nx^2+1=0\n\\]\n\nEnd');
	const displayEquation = page.locator('.cm-composer-math-display');
	await expect(displayEquation.locator('.katex-display')).toBeVisible();
	await displayEquation.click({ timeout: 10_000 });
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.toString()))
		.toBe('\nx^2+1=0\n');
	await page.keyboard.insertText('x^3+1=0');
	await editor.press('Enter');
	await expectDraft(page, 'Equation:\n\n\\[x^3+1=0\n\\]\n\nEnd');
	await expect.poll(() => requestCount(page)).toBe(1);
	await editor.press('ControlOrMeta+End');
	await expect(displayEquation.locator('.katex-display')).toBeVisible();
	await page.screenshot({
		path: '/tmp/freelm-smart-composer-display-math.png',
		animations: 'disabled',
	});
	await editor.press('ControlOrMeta+Enter');
	await expect.poll(() => lastUserInput(page)).toBe('Equation:\n\n\\[x^3+1=0\n\\]\n\nEnd');
});

test('older messages can be regenerated and edited without losing the original versions; branches preserve their parent', async ({
	page,
}) => {
	await fixture(page);
	const olderAnswer = page.locator('[data-message-id="first-answer"]');
	// Message actions become interactive only while their message is hovered.
	await olderAnswer.hover();
	await olderAnswer.getByRole('button', { name: 'Regenerate response', exact: true }).click();
	await expect(page.locator('.message.assistant').last()).toContainText('Generated answer');
	await page.locator('.message.assistant').last().hover();
	await page.getByRole('button', { name: 'Previous response version', exact: true }).click();
	await expect(page.locator('[data-message-id="first-answer"]')).toContainText('Original answer');
	await expect(page.locator('[data-message-id="second-answer"]')).toContainText('Latest answer');
	await olderAnswer.hover();
	await olderAnswer.getByRole('button', { name: 'Branch conversation', exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(2);
	await expect(page.locator('[data-message-id="first-user"]')).toContainText('Original question');
	await expect(page.locator('[data-message-id="first-answer"]')).toContainText('Original answer');
	await expect(page.locator('[data-message-id="second-user"]')).toHaveCount(0);
	await expect(page.locator('[data-message-id="second-answer"]')).toHaveCount(0);
	await expect
		.poll(() =>
			page.evaluate(() => {
				const state = (window as any).__composerFixture.state();
				return state.threads.find(
					(entry: Thread) => entry.id !== 'composer-thread' && entry.branchedFrom,
				)?.branchedFrom;
			}),
		)
		.toEqual({ threadId: 'composer-thread', messageId: 'first-answer' });
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expect(page.locator('.message')).toHaveCount(4);
	await expect(page.locator('[data-message-id="second-user"]')).toContainText('Latest question');
	await expect(page.locator('[data-message-id="second-answer"]')).toContainText('Latest answer');
	await page.locator('[data-message-id="first-user"]').hover();
	await page
		.locator('[data-message-id="first-user"]')
		.getByRole('button', { name: 'Edit message', exact: true })
		.click();
	await page
		.getByRole('textbox', { name: 'Edit message', exact: true })
		.fill('Changed original question');
	await page.getByRole('button', { name: 'Save and send', exact: true }).click();
	await expect(page.locator('.message.user').first()).toContainText('Changed original question');
	await expect(page.locator('.message.assistant').last()).toContainText('Generated answer');
	await expect(
		page
			.locator('.message.user')
			.first()
			.getByRole('button', { name: 'Branch conversation', exact: true }),
	).toHaveCount(0);
	await page.locator('.message.assistant').last().hover();
	await page
		.locator('.message.assistant')
		.last()
		.getByRole('button', { name: 'Branch conversation', exact: true })
		.click();
	await expect(page.locator('.message.user').first()).toContainText('Changed original question');
	await expect(page.locator('.message')).toHaveCount(2);
	await expect(page.locator('.message.assistant').last()).toContainText('Generated answer');
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expect(page.locator('.message.assistant').last()).toContainText('Generated answer');
});

test('selected text stays separate from the draft and dictation transcribes without sending', async ({
	page,
}) => {
	await fixture(page, true);
	const answer = page.locator('[data-message-id="second-answer"] .message-content');
	await answer.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await answer.dispatchEvent('pointerup');
	await page.getByRole('button', { name: 'Reply to selection', exact: true }).click();
	await expectDraft(page, '');
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as any).__composerFixture.state().chatDrafts?.['composer-thread']?.replyTo,
			),
		)
		.toEqual({ messageId: 'second-answer', text: 'Latest answer' });
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
	await expectDraft(page, 'A dictated message');
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
	await expect(page.locator('.message')).toHaveCount(4);
	await expect
		.poll(() => page.evaluate(() => (window as any).__composerFixture.stoppedTracks))
		.toBeGreaterThan(0);
});

test('reply references and dictated text survive while the editor module is still loading', async ({
	page,
}) => {
	const releaseEditor = await fixture(page, true, true);
	try {
		await expect(composer(page)).toHaveCount(0);
		const answer = page.locator('[data-message-id="second-answer"] .message-content');
		await answer.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
		});
		await answer.dispatchEvent('pointerup');
		await page.getByRole('button', { name: 'Reply to selection', exact: true }).click();
		await expectDraft(page, '');
		await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
		await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
		await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
		await expectDraft(page, 'A dictated message');
		await expect.poll(() => requestCount(page)).toBe(1);
		await expect(page.locator('.message')).toHaveCount(4);
	} finally {
		releaseEditor();
	}
	await expect(composer(page)).toBeVisible({ timeout: 30_000 });
	await expect(composer(page)).not.toContainText('Latest answer');
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
	await expect(composer(page)).toContainText('A dictated message');
	await composer(page).press('ControlOrMeta+End');
	await composer(page).pressSequentially(' still here');
	await expectDraft(page, 'A dictated message still here');
});

test('reply references persist, can be removed, and accompany the sent prompt without becoming editable text', async ({
	page,
}) => {
	await fixture(page);
	const editor = composer(page);
	await editor.fill('Tell me more.');
	const answer = page.locator('[data-message-id="second-answer"] .message-content');
	async function attachReply() {
		await answer.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.addRange(range);
		});
		await answer.dispatchEvent('pointerup');
		await page.getByRole('button', { name: 'Reply to selection', exact: true }).click();
	}
	await attachReply();
	await expectDraft(page, 'Tell me more.');
	await page.getByRole('button', { name: 'Other conversation', exact: true }).click();
	await expect(page.locator('.composer-reply-reference')).toHaveCount(0);
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
	await page.reload();
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
	await expectDraft(page, 'Tell me more.');
	await page.getByRole('button', { name: 'Remove reply reference', exact: true }).click();
	await expect(page.locator('.composer-reply-reference')).toHaveCount(0);
	await expectDraft(page, 'Tell me more.');
	await attachReply();
	await page.screenshot({
		path: '/tmp/freelm-reply-reference-desktop.png',
		animations: 'disabled',
	});
	await page.setViewportSize({ width: 820, height: 900 });
	await page.screenshot({ path: '/tmp/freelm-reply-reference-narrow.png', animations: 'disabled' });
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect(page.locator('.message.user').last()).toContainText('Tell me more.');
	await expect(
		page.locator('.message.user').last().locator('.message-reply-reference'),
	).toContainText('Latest answer');
	await expect(page.locator('.composer-reply-reference')).toHaveCount(0);
	await expectDraft(page, '');
	await expect.poll(() => lastUserInput(page)).toContain('Latest answer');
	await expect.poll(() => lastUserInput(page)).toContain('Tell me more.');
	const user = await page.evaluate(() =>
		(window as any).__composerFixture
			.state()
			.threads.find((thread: any) => thread.id === 'composer-thread')
			.messages.filter((message: any) => message.role === 'user')
			.at(-1),
	);
	expect(user.content).toBe('Tell me more.');
	expect(user.replyTo).toEqual({ messageId: 'second-answer', text: 'Latest answer' });
	await editor.press('ArrowUp');
	await expectDraft(page, 'Tell me more.');
	await expect(page.locator('.composer-reply-reference')).toContainText('Latest answer');
});

test('typing a third backtick opens an editable block; Enter adds code lines and explicit send preserves fences', async ({
	page,
}) => {
	await fixture(page);
	const editor = composer(page);
	await editor.pressSequentially('```');
	await expectDraft(page, '```\n\n```\n');
	await expect(page.locator('.cm-composer-code-line')).toBeVisible();
	await editor.pressSequentially('print(1)');
	await editor.press('Enter');
	await editor.pressSequentially('print(2)');
	await expectDraft(page, '```\nprint(1)\nprint(2)\n```\n');
	await expect.poll(() => requestCount(page)).toBe(0);
	await expect(page.locator('.cm-composer-code-line')).toHaveCount(2);
	const block = await page.locator('.markdown-composer').evaluate((element) => {
		const header = element.querySelector('.cm-composer-code-header')!.getBoundingClientRect();
		const footer = element.querySelector('.cm-composer-code-footer')!.getBoundingClientRect();
		const lines = [...element.querySelectorAll('.cm-composer-code-line')];
		return {
			headerGap: lines[0].getBoundingClientRect().top - header.bottom,
			footerGap: footer.top - lines.at(-1)!.getBoundingClientRect().bottom,
		};
	});
	expect(Math.abs(block.headerGap)).toBeLessThanOrEqual(1);
	expect(Math.abs(block.footerGap)).toBeLessThanOrEqual(1);
	await page.screenshot({ path: '/tmp/freelm-smart-composer-code.png', animations: 'disabled' });
	await page.locator('.cm-composer-code-header').click({ timeout: 10_000 });
	await expect(editor).toContainText('```');
	await editor.press('ControlOrMeta+End');
	await expect(page.locator('.cm-composer-code-header')).toBeVisible();
	await editor.press('ControlOrMeta+Enter');
	await expect.poll(() => lastUserInput(page)).toBe('```\nprint(1)\nprint(2)\n```\n');
	await expectDraft(page, '');
	await editor.fill('A plain message');
	await editor.press('Shift+Enter');
	await page.keyboard.insertText('on two lines');
	await expectDraft(page, 'A plain message\non two lines');
	await editor.press('Enter');
	await expect.poll(() => lastUserInput(page)).toBe('A plain message\non two lines');
});

test('Markdown drafts preserve whitespace across reload, while undo remains isolated to the current conversation', async ({
	page,
}) => {
	await fixture(page);
	const editor = composer(page);
	const source =
		'  An exact draft: café 🪐\n\n```python\n  value = 2  \n\n  print(value)\n```\n\n\\[x^2\\]\n';
	await editor.fill(source);
	await expectDraft(page, source);
	await page.reload();
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expectDraft(page, source);
	await expect(editor).toContainText('value = 2');
	await editor.fill('First conversation');
	await editor.pressSequentially(' tail');
	await expectDraft(page, 'First conversation tail');
	await page.getByRole('button', { name: 'Other conversation', exact: true }).click();
	await expectDraft(page, '', 'other-thread');
	await editor.press('ControlOrMeta+z');
	await expectDraft(page, '', 'other-thread');
	await editor.fill('Other conversation');
	await expectDraft(page, 'Other conversation', 'other-thread');
	// One insertion keeps this undo assertion independent of the interval between
	// individual keyboard protocol calls on a busy automation host.
	await page.keyboard.insertText(' addition');
	await editor.press('ControlOrMeta+z');
	await expectDraft(page, 'Other conversation', 'other-thread');
	await page.getByRole('button', { name: 'Composer examples', exact: true }).click();
	await expectDraft(page, 'First conversation tail');
	await editor.press('ControlOrMeta+z');
	await expectDraft(page, 'First conversation tail');
	await editor.fill(source);
	await expectDraft(page, source);
	await editor.press('ControlOrMeta+Enter');
	await expect.poll(() => lastUserInput(page)).toBe(source);
});

test('rich paste and cursor dictation participate in undo; formatted clipboard code pastes as literal source', async ({
	page,
}) => {
	await fixture(page, true);
	const editor = composer(page);
	await editor.fill('Before after');
	await editor.press('Home');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await editor.press('ArrowRight');
	await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
	await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
	await expectDraft(page, 'Before A dictated message after');
	await editor.press('ControlOrMeta+z');
	await expectDraft(page, 'Before after');
	await editor.press('ControlOrMeta+Shift+z');
	await expectDraft(page, 'Before A dictated message after');
	await editor.fill('Prefix ');
	await paste(
		editor,
		'A link',
		'<p><a href="https://example.com/">A link</a></p><iframe src="https://evil.invalid/"></iframe>',
	);
	await expectDraft(page, 'Prefix [A link](https://example.com/)');
	await editor.press('ControlOrMeta+z');
	await expectDraft(page, 'Prefix ');
	await editor.fill('```javascript\n\n```\n');
	await editor.press('ControlOrMeta+Home');
	await editor.press('ArrowDown');
	const code = 'const x = "<strong>literal</strong>";\n  console.log(x);';
	await paste(
		editor,
		code,
		'<pre><span>const x = "&lt;strong&gt;literal&lt;/strong&gt;";</span>\n  console.log(x);</pre>',
	);
	await expectDraft(page, `\`\`\`javascript\n${code}\n\`\`\`\n`);
	await expect.poll(() => requestCount(page)).toBe(1);
});

test('IME candidate confirmation never sends, including Enter before the first composition edit', async ({
	page,
}) => {
	await fixture(page);
	const editor = composer(page);
	await editor.fill('Input ');
	await expectDraft(page, 'Input ');
	await editor.dispatchEvent('compositionstart', { data: '' });
	await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
	await expect.poll(() => requestCount(page)).toBe(0);
	await expectDraft(page, 'Input ');
	await editor.dispatchEvent('keydown', {
		key: 'Enter',
		code: 'Enter',
		keyCode: 229,
		isComposing: true,
	});
	await expect.poll(() => requestCount(page)).toBe(0);
	await expectDraft(page, 'Input ');
	await page.keyboard.insertText('語');
	await editor.dispatchEvent('compositionend', { data: '語' });
	await expectDraft(page, 'Input 語');
	await page.getByRole('button', { name: 'Send message', exact: true }).click();
	await expect.poll(() => lastUserInput(page)).toBe('Input 語');
});

test('the editor grows to its height cap while the toolbar remains reachable on desktop and narrow windows', async ({
	page,
}) => {
	await fixture(page, true);
	const editor = composer(page);
	const scroller = page.locator('.markdown-composer .cm-scroller');
	await editor.fill('One line');
	const initial = await scroller.boundingBox();
	await editor.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join('\n'));
	await expect
		.poll(async () => (await scroller.boundingBox())!.height)
		.toBeGreaterThan(initial!.height + 50);
	await editor.fill(
		Array.from({ length: 90 }, (_, index) => `Line ${index + 1}: readable Markdown input`).join(
			'\n',
		),
	);
	await expect.poll(async () => (await scroller.boundingBox())!.height).toBeLessThanOrEqual(601);
	await expect
		.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
		.toBe(true);
	for (const width of [1440, 480]) {
		await page.setViewportSize({ width, height: 940 });
		if (width === 480)
			await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
		const geometry = await page.locator('.composer').evaluate((element) => {
			const box = element.getBoundingClientRect();
			const toolbar = element.querySelector('.composer-toolbar')!.getBoundingClientRect();
			const tools = element.querySelector('.composer-tools')!.getBoundingClientRect();
			const actions = element.querySelector('.composer-actions')!.getBoundingClientRect();
			return {
				left: box.left,
				right: box.right,
				toolbarLeft: toolbar.left,
				toolbarRight: toolbar.right,
				toolbarBottom: toolbar.bottom,
				toolsRight: tools.right,
				actionsLeft: actions.left,
				documentWidth: document.documentElement.scrollWidth,
				width: window.innerWidth,
			};
		});
		expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
		expect(geometry.toolbarLeft).toBeGreaterThanOrEqual(geometry.left);
		expect(geometry.toolbarRight).toBeLessThanOrEqual(geometry.right);
		expect(geometry.toolbarBottom).toBeLessThanOrEqual(940);
		expect(geometry.toolsRight).toBeLessThanOrEqual(geometry.actionsLeft);
		await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
		expect(
			await page.getByRole('button', { name: 'Send message', exact: true }).evaluate((button) => {
				const rect = button.getBoundingClientRect();
				return button.contains(
					document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
				);
			}),
		).toBe(true);
	}
	// CodeMirror virtualizes long documents, so select the logical document via
	// its normal keyboard command rather than replacing only mounted DOM lines.
	await editor.press('ControlOrMeta+a');
	await page.keyboard.insertText('A smart composer in a narrow window.');
	await expectDraft(page, 'A smart composer in a narrow window.');
	await expect(editor).toContainText('A smart composer in a narrow window.');
	await expect.poll(async () => (await scroller.boundingBox())!.height).toBeLessThan(120);
	await page.screenshot({ path: '/tmp/freelm-smart-composer-narrow.png', animations: 'disabled' });
});
