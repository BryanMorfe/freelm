import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from '../src/lib/clipboard';

afterEach(() => vi.unstubAllGlobals());

describe('copy to clipboard', () => {
	it('uses the local native clipboard without requesting browser clipboard permissions', async () => {
		const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
		vi.stubGlobal('window', { desktop: { clipboardWriteText } });
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const text = 'Café 你好 👋\n  const value = "quoted";\n';
		await copyToClipboard(text);
		expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith(text);
		expect(writeText).not.toHaveBeenCalled();
	});

	it.each([undefined, {}])(
		'retains browser copy when the native method is unavailable',
		async (desktop) => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal('window', { desktop });
			vi.stubGlobal('navigator', { clipboard: { writeText } });
			await copyToClipboard('**Markdown**\n\n```js\nconst x = 1;\n```');
			expect(writeText).toHaveBeenCalledExactlyOnceWith('**Markdown**\n\n```js\nconst x = 1;\n```');
		},
	);

	it('reports native write failures rather than falling back or claiming success', async () => {
		const error = new Error('Native clipboard failed');
		const writeText = vi.fn();
		vi.stubGlobal('window', { desktop: { clipboardWriteText: vi.fn().mockRejectedValue(error) } });
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		await expect(copyToClipboard('text')).rejects.toBe(error);
		expect(writeText).not.toHaveBeenCalled();
	});

	it('reports browser write failures', async () => {
		const error = new Error('Permission denied');
		vi.stubGlobal('window', {});
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(error) } });
		await expect(copyToClipboard('text')).rejects.toBe(error);
	});
});
