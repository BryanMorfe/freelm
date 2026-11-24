import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assertSafeMediaAssetUrl,
	detectSupportedMediaContentType,
} from '../electron/image-assets';
import { CompletionNotifications } from '../electron/completion-notifications';
import { assertToolSettingsValues } from '../src/components/ToolSettings';
import { defaultToolSettings } from '../src/lib/tool-settings';

describe('media asset SSRF and content-type hardening', () => {
	it('blocks cloud metadata and unrelated private/loopback URLs while allowing same-origin local provider media', () => {
		expect(() => assertSafeMediaAssetUrl('http://169.254.169.254/latest/meta-data')).toThrow();
		expect(() =>
			assertSafeMediaAssetUrl('http://169.254.169.254/image.png', 'http://169.254.169.254/v1'),
		).toThrow();
		expect(() =>
			assertSafeMediaAssetUrl('http://127.0.0.1:9999/secret', 'http://127.0.0.1:8000/v1'),
		).toThrow();
		expect(() =>
			assertSafeMediaAssetUrl('http://10.0.0.5/internal', 'https://api.example.com/v1'),
		).toThrow();
		expect(() =>
			assertSafeMediaAssetUrl('http://localhost:4319/workspace', 'https://api.example.com/v1'),
		).toThrow();
		// Same-origin local provider media remains allowed.
		expect(
			assertSafeMediaAssetUrl('http://127.0.0.1:8000/image.png', 'http://127.0.0.1:8000/v1').href,
		).toBe('http://127.0.0.1:8000/image.png');
		// Public CDN media remains allowed.
		expect(
			assertSafeMediaAssetUrl('https://cdn.example.com/out.png', 'https://api.example.com/v1').href,
		).toBe('https://cdn.example.com/out.png');
	});

	it('rejects non-media MIME types and accepts supported image/video payloads', () => {
		expect(
			detectSupportedMediaContentType(Buffer.from('<html>secret</html>'), 'text/html'),
		).toBeUndefined();
		expect(
			detectSupportedMediaContentType(Buffer.from('{"token":"abc"}'), 'application/json'),
		).toBeUndefined();
		expect(
			detectSupportedMediaContentType(
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
				'application/octet-stream',
			),
		).toBe('image/png');
		expect(
			detectSupportedMediaContentType(Buffer.from([137, 80, 78, 71]), 'image/png'),
		).toBe('image/png');
	});
});

describe('completion notifications corruption recovery', () => {
	it('recovers when the receipts file is corrupted instead of failing permanently', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'freelm-notif-'));
		const filename = path.join(dir, 'completion-notifications.json');
		await writeFile(filename, '{broken json', 'utf8');
		const shown: string[] = [];
		const notifications = new CompletionNotifications({
			filename,
			preferences: async () => ({ backgroundNotifications: true }),
			focused: () => false,
			supported: () => true,
			show: ({ title }) => shown.push(title),
			sound: () => {},
		});
		const status = await notifications.emit({
			destination: {
				hostId: 'local',
				workspaceId: 'local',
				kind: 'thread',
				entityId: 'thread-1',
				runId: 'run-1',
			},
			outcome: 'completed',
			title: 'Recovered',
		});
		expect(status).toBe('submitted');
		expect(shown).toHaveLength(1);
	});
});

describe('cross-platform tool settings path validation', () => {
	it('accepts Unix and Windows absolute paths and rejects relative paths', () => {
		const base = defaultToolSettings();
		expect(() =>
			assertToolSettingsValues(
				{ ...base, workspaceRoot: '/Users/dev/project', skillDirectories: ['/opt/skills'] },
				[],
			),
		).not.toThrow();
		expect(() =>
			assertToolSettingsValues(
				{
					...base,
					workspaceRoot: 'C:\\Users\\dev\\project',
					skillDirectories: ['D:\\skills', '\\\\server\\share\\skills'],
				},
				[],
			),
		).not.toThrow();
		expect(() =>
			assertToolSettingsValues({ ...base, workspaceRoot: 'relative/path' }, []),
		).toThrow();
	});
});
