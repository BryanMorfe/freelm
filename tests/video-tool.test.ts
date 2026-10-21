import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, WireRequest, WireResponse } from '../src/types';
import {
	configuredVideoTool,
	executeVideoGeneration,
	resolveVideoToolSeconds,
	resolveVideoToolSize,
	VIDEO_TOOL_POLL_MS,
} from '../src/lib/video-tool';
import { assertChatToolCall, machineIndependentTools } from '../src/lib/conversation-tools';

const connection: Connection = {
	id: 'video',
	name: 'Video API',
	baseUrl: 'https://video.invalid/v1',
	apiKey: 'secret-key',
	chatApi: 'responses',
	models: { chat: '', images: '', videos: 'video-model', speech: '', transcription: '' },
	discoveredModels: [],
};
const config = {
	enabled: true,
	connectionId: connection.id,
	model: 'video-model',
	size: '1920x1088',
	seconds: '15',
};
const json = (data: unknown, status = 200): WireResponse => ({
	status,
	encoding: 'text',
	contentType: 'application/json',
	body: JSON.stringify(data),
});
const binary: WireResponse = {
	status: 200,
	encoding: 'base64',
	contentType: 'video/mp4',
	body: 'dmlydHVhbCB2aWRlbw==',
};
const options = { model: config.model, prompt: 'Waves at sunset.' };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe('video tool parameters and catalogs', () => {
	it('defaults video dimensions explicitly while keeping duration optional', () => {
		expect(resolveVideoToolSize(undefined, '')).toBe('1280x736');
		expect(resolveVideoToolSize(undefined, '   ')).toBe('1280x736');
		expect(resolveVideoToolSize('', '720x1280')).toBe('736x1280');
		expect(resolveVideoToolSize('   ', '')).toBe('1280x736');
		expect(resolveVideoToolSize('1920x1080', config.size)).toBe('1920x1088');
		expect(resolveVideoToolSize(undefined, '720×1280')).toBe('736x1280');
		expect(resolveVideoToolSeconds(15, '4')).toBe('15');
		expect(resolveVideoToolSeconds(undefined, '')).toBeUndefined();
		expect(resolveVideoToolSeconds('2.5', '4')).toBe('2.5');
	});
	it.each(['nope', 'auto', '0x10', '1x0', {}, '9007199254740991x32'])(
		'rejects invalid dimensions %j',
		(value) => {
			expect(() => resolveVideoToolSize(value, '')).toThrow(/Video/);
		},
	);
	it.each([0, -1, Infinity, NaN, 'NaN', '1e5', ' ', {}, 'four'])(
		'rejects invalid duration %j',
		(value) => {
			expect(() => resolveVideoToolSeconds(value, '')).toThrow(/duration/);
		},
	);
	it('offers only recent images to Chat and preserves model-specific defaults through filtering', () => {
		const chat = configuredVideoTool(connection, config, 'chat');
		expect(chat.parameters.properties).not.toHaveProperty('referenced_image_paths');
		expect(chat.parameters.properties).toHaveProperty('num_last_images_to_include');
		expect(chat.parameters.required).toEqual(['prompt']);
		expect(JSON.stringify(chat)).toContain('1920x1088');
		expect(JSON.stringify(chat)).toContain('15 seconds');
		expect(JSON.stringify(chat)).not.toContain(connection.apiKey);
		expect(machineIndependentTools([chat])[0].parameters).toEqual(chat.parameters);
		expect(() =>
			assertChatToolCall(chat.name, { prompt: 'a river', referenced_image_paths: [] }),
		).toThrow(/cannot read local/);
		expect(() =>
			assertChatToolCall(chat.name, { prompt: 'a river', num_last_images_to_include: 1 }),
		).not.toThrow();
		expect(configuredVideoTool(connection, config, 'code').parameters.properties).toHaveProperty(
			'referenced_image_paths',
		);
	});
});

describe('video provider job lifecycle', () => {
	it('reuses a guarded immediate video snapshot larger than one megabyte without downloading or evaluating twice', async () => {
		const base64 = Buffer.alloc(800_000, 1).toString('base64');
		const snapshot = `data:video/mp4;base64,${base64}`;
		const response = json({ id: 'immediate', status: 'completed', video_url: snapshot });
		expect(response.body.length).toBeGreaterThan(1_000_000);
		const execute = vi.fn().mockResolvedValueOnce(response);
		const result = await executeVideoGeneration(connection, options, execute, signal());
		expect(result.content.at(-1)).toMatchObject({
			type: 'file',
			mimeType: 'video/mp4',
			dataUrl: snapshot,
		});
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('does not release an inline snapshot when the provider reports a failed immediate job', async () => {
		const execute = vi.fn().mockResolvedValueOnce(
			json({
				id: 'failed-inline',
				status: 'failed',
				error: { message: 'Rendering failed.' },
				video_url: `data:video/mp4;base64,${binary.body}`,
			}),
		);
		await expect(executeVideoGeneration(connection, options, execute, signal())).rejects.toThrow(
			/Rendering failed/,
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('fetches content through moderation instead of trusting inline media returned by a status GET', async () => {
		vi.useFakeTimers();
		const unreviewed = `data:video/mp4;base64,${Buffer.from('unreviewed bytes').toString('base64')}`;
		const execute = vi
			.fn()
			.mockResolvedValueOnce(json({ id: 'polled-inline', status: 'queued' }))
			.mockResolvedValueOnce(
				json({ id: 'polled-inline', status: 'completed', video_url: unreviewed }),
			)
			.mockResolvedValueOnce(binary);
		const pending = executeVideoGeneration(connection, options, execute, signal());
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS);
		const result = await pending;
		expect(result.content.at(-1)).toMatchObject({
			dataUrl: `data:video/mp4;base64,${binary.body}`,
		});
		expect(execute.mock.calls.at(-1)![0].path).toBe('/videos/polled-inline/content');
		expect(JSON.stringify(result)).not.toContain(unreviewed);
	});
	it.each(['../escape', '.', '..', 'folder/job', 'folder\\job', '%2e%2e', 'job\nnext'])(
		'rejects provider ID %j before it can escape the moderated content route',
		async (id) => {
			const execute = vi.fn().mockResolvedValue(json({ id, status: 'completed' }));
			await expect(executeVideoGeneration(connection, options, execute, signal())).rejects.toThrow(
				/usable ID/,
			);
			expect(execute).toHaveBeenCalledTimes(1);
		},
	);
	it('posts multipart options and one reference, polls and releases only moderated content', async () => {
		vi.useFakeTimers();
		const execute = vi
			.fn()
			.mockResolvedValueOnce({
				...json({ id: 'job one', status: 'queued' }),
				moderationWarnings: ['Evaluator is not configured.'],
			})
			.mockResolvedValueOnce(json({ id: 'job one', status: 'in_progress' }))
			.mockResolvedValueOnce(json({ id: 'job one', status: 'completed' }))
			.mockResolvedValueOnce(binary);
		const pending = executeVideoGeneration(
			connection,
			{
				...options,
				size: '1920x1088',
				seconds: '15',
				reference: {
					name: 'source.png',
					type: 'image/png',
					dataUrl: 'data:image/png;base64,aW1hZ2U=',
				},
			},
			execute,
			signal(),
		);
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS * 2);
		const result = await pending;
		expect(execute.mock.calls.map(([request]) => request.path)).toEqual([
			'/videos',
			'/videos/job%20one',
			'/videos/job%20one',
			'/videos/job%20one/content',
		]);
		expect(execute.mock.calls[0][0]).toMatchObject({
			baseUrl: connection.baseUrl,
			apiKey: connection.apiKey,
			method: 'POST',
			form: [
				{ name: 'model', value: config.model },
				{ name: 'prompt', value: options.prompt },
				{ name: 'size', value: '1920x1088' },
				{ name: 'seconds', value: '15' },
				{
					name: 'input_reference',
					file: { name: 'source.png', type: 'image/png', base64: 'aW1hZ2U=' },
				},
			],
		});
		expect(result.content.at(-1)).toMatchObject({
			type: 'file',
			mimeType: 'video/mp4',
			dataUrl: `data:video/mp4;base64,${binary.body}`,
		});
		expect(result.moderationWarnings).toEqual(['Evaluator is not configured.']);
		expect(
			result.content
				.filter((item) => item.type === 'text')
				.map((item) => item.text)
				.join('\n'),
		).not.toContain(binary.body);
	});
	it('keeps checking beyond four hours without re-submitting the accepted job', async () => {
		vi.useFakeTimers();
		let complete = false;
		const execute = vi.fn(async (request: WireRequest) =>
			request.path.endsWith('/content')
				? binary
				: json({ id: 'slow', status: complete ? 'completed' : 'in_progress' }),
		);
		const pending = executeVideoGeneration(connection, options, execute, signal());
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 10_000);
		complete = true;
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS);
		expect((await pending).content.at(-1)?.type).toBe('file');
		expect(execute.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
	});
	it.each(['failed', 'cancelled', 'error'])(
		'reports terminal %s and its provider job without downloading',
		async (status) => {
			const execute = vi
				.fn()
				.mockResolvedValue(
					json({ id: 'failed-job', status, error: { message: 'Provider capacity error' } }),
				);
			await expect(executeVideoGeneration(connection, options, execute, signal())).rejects.toThrow(
				/Provider capacity error.*failed-job/,
			);
			expect(execute).toHaveBeenCalledTimes(1);
		},
	);
	it('stops an in-flight poll on cancellation and does not create another video', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const execute = vi.fn().mockResolvedValue(json({ id: 'cancel-job', status: 'queued' }));
		const pending = executeVideoGeneration(connection, options, execute, controller.signal);
		const rejected = expect(pending).rejects.toThrow(/Stopped/);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort(new Error('Stopped by user'));
		await rejected;
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('does not release video bytes when output moderation rejects content', async () => {
		const denied = new Error('Video output was blocked by High moderation.');
		denied.name = 'MediaModerationError';
		const execute = vi
			.fn()
			.mockResolvedValueOnce(json({ id: 'blocked-output', status: 'completed' }))
			.mockRejectedValueOnce(denied);
		await expect(
			executeVideoGeneration(connection, options, execute, signal()),
		).rejects.toMatchObject({
			name: 'MediaModerationError',
			message: expect.stringContaining('blocked-output'),
		});
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('retains accepted job ID after transport failure and never retries creation', async () => {
		vi.useFakeTimers();
		const execute = vi
			.fn()
			.mockResolvedValueOnce(json({ id: 'retained', status: 'queued' }))
			.mockRejectedValueOnce(new Error('Network unavailable'));
		const pending = executeVideoGeneration(connection, options, execute, signal());
		const rejected = expect(pending).rejects.toThrow(
			/Network unavailable.*retained.*do not automatically submit/i,
		);
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS);
		await rejected;
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('does not follow provider-controlled URLs or accept a changed job identity', async () => {
		vi.useFakeTimers();
		const execute = vi
			.fn()
			.mockResolvedValueOnce(
				json({ id: 'first', status: 'queued', url: 'https://evil.invalid/steal' }),
			)
			.mockResolvedValueOnce(json({ id: 'different', status: 'completed' }));
		const pending = executeVideoGeneration(connection, options, execute, signal());
		const rejected = expect(pending).rejects.toThrow(/different job ID/);
		await vi.advanceTimersByTimeAsync(VIDEO_TOOL_POLL_MS);
		await rejected;
		expect(execute.mock.calls.every(([request]) => request.baseUrl === connection.baseUrl)).toBe(
			true,
		);
	});
	it('rechecks live configuration before retrieving content', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(json({ id: 'settings-change', status: 'completed' }));
		const check = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('Video model settings changed.'));
		await expect(
			executeVideoGeneration(connection, options, execute, signal(), check),
		).rejects.toThrow(/settings changed/);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('rejects text masquerading as output content', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(json({ id: 'bad-content', status: 'completed' }))
			.mockResolvedValueOnce(json({ malicious: true }));
		await expect(executeVideoGeneration(connection, options, execute, signal())).rejects.toThrow(
			/unsupported or oversized/,
		);
	});
});
