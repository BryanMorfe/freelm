import { afterEach, describe, expect, it, vi } from 'vitest';
import { RendererTaskBridge } from '../../electron/bot-task-service';
import {
	MAX_BOT_TASK_REQUEST_BYTES,
	MAX_BOT_TASK_RESPONSE_BYTES,
	validateBotTaskRequest,
	validateBotTaskResponse,
	type BotTaskRequest,
} from '../../src/bot-task-types';

const services: RendererTaskBridge[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
	vi.useRealTimers();
});

function fixture(timeoutMs = 90_000) {
	const requests: BotTaskRequest[] = [];
	const cancel = vi.fn();
	const service = new RendererTaskBridge({
		deliver: (request) => {
			requests.push(request);
		},
		cancel,
		timeoutMs,
	});
	services.push(service);
	service.setReady(true);
	return { service, requests, cancel };
}
const request = (argumentsValue: Record<string, unknown> = {}) => ({
	id: 'delivery-1',
	operationId: 'stable-operation-1',
	name: 'threads_send',
	arguments: argumentsValue,
});

describe('renderer bot task bridge', () => {
	it('only dispatches while a local workspace renderer is registered', async () => {
		const { service, requests } = fixture();
		service.setReady(false);
		await expect(service.execute('threads_list', {}, 'op')).rejects.toThrow('Open this computer');
		expect(requests).toEqual([]);
		service.setReady(true);
		const pending = service.execute('threads_list', {}, 'op');
		expect(service.settle(requests[0].id, { ok: true, result: { threads: [] } })).toBe(true);
		await expect(pending).resolves.toEqual({ threads: [] });
	});

	it('correlates concurrent requests without cross-settling or reusing delivery IDs', async () => {
		const { service, requests } = fixture();
		const first = service.execute('threads_read', { threadId: 'one' }, 'op-one');
		const second = service.execute('threads_read', { threadId: 'two' }, 'op-two');
		expect(requests[0].id).not.toBe(requests[1].id);
		expect(service.settle('not-a-request', { ok: true, result: 'wrong' })).toBe(false);
		expect(service.settle(requests[1].id, { ok: true, result: 'second' })).toBe(true);
		expect(service.settle(requests[1].id, { ok: true, result: 'duplicate' })).toBe(false);
		service.settle(requests[0].id, { ok: true, result: 'first' });
		await expect(first).resolves.toBe('first');
		await expect(second).resolves.toBe('second');
		const retry = service.execute('threads_read', { threadId: 'one' }, 'op-one');
		expect(requests[2].id).not.toBe(requests[0].id);
		expect(requests[2].operationId).toBe('op-one');
		service.settle(requests[2].id, { ok: true, result: null });
		await expect(retry).resolves.toBeNull();
	});

	it('cancels pending operations and ignores late replies after caller cancellation', async () => {
		const { service, requests, cancel } = fixture();
		const controller = new AbortController();
		const pending = service.execute('threads_wait', { threadId: 'one' }, 'op', controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		controller.abort();
		await rejected;
		expect(cancel).toHaveBeenCalledExactlyOnceWith(requests[0].id);
		expect(service.settle(requests[0].id, { ok: true, result: 'late' })).toBe(false);
	});

	it('does not deliver requests whose callers have already cancelled', async () => {
		const { service, requests, cancel } = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			service.execute('threads_create', {}, 'op', controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(requests).toHaveLength(0);
		expect(cancel).not.toHaveBeenCalled();
	});

	it('expires at 90 seconds, notifies cancellation, and discards late completion', async () => {
		vi.useFakeTimers();
		const { service, requests, cancel } = fixture();
		const pending = service.execute('threads_wait', {}, 'op');
		const rejected = expect(pending).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(89_999);
		expect(cancel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(cancel).toHaveBeenCalledExactlyOnceWith(requests[0].id);
		expect(service.settle(requests[0].id, { ok: true, result: 'late' })).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels all requests on workspace departure and never revives requests on return', async () => {
		const { service, requests, cancel } = fixture();
		const first = service.execute('threads_wait', {}, 'first');
		const second = service.execute('threads_send', {}, 'second');
		const rejected = Promise.all([
			expect(first).rejects.toThrow('no longer available'),
			expect(second).rejects.toThrow('no longer available'),
		]);
		service.setReady(false);
		await rejected;
		expect(cancel).toHaveBeenCalledTimes(2);
		service.setReady(true);
		for (const item of requests)
			expect(service.settle(item.id, { ok: true, result: null })).toBe(false);
	});

	it('cleans timers and listeners after success, renderer errors, and delivery exceptions', async () => {
		vi.useFakeTimers();
		const { service, requests, cancel } = fixture();
		const controller = new AbortController();
		const pending = service.execute('threads_send', {}, 'op', controller.signal);
		service.settle(requests[0].id, { ok: false, error: 'This thread is busy.' });
		await expect(pending).rejects.toThrow('This thread is busy.');
		controller.abort();
		expect(cancel).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		const broken = new RendererTaskBridge({
			deliver: () => {
				throw new Error('Window closed.');
			},
		});
		services.push(broken);
		broken.setReady(true);
		await expect(broken.execute('threads_list', {}, 'op')).rejects.toThrow('Window closed.');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects invalid and oversized replies without leaving the caller waiting', async () => {
		const { service, requests } = fixture();
		const pending = service.execute('threads_read', {}, 'op');
		service.settle(requests[0].id, { ok: true, result: 'x'.repeat(MAX_BOT_TASK_RESPONSE_BYTES) });
		await expect(pending).rejects.toThrow('transport limit');
		expect(service.settle(requests[0].id, { ok: true, result: null })).toBe(false);
	});

	it('rejects unapproved task names before delivery and stays closed after shutdown', async () => {
		const { service, requests } = fixture();
		await expect(service.execute('exec_command', { command: 'rm -rf /' }, 'op')).rejects.toThrow(
			'Invalid bot task',
		);
		expect(requests).toHaveLength(0);
		const pending = service.execute('threads_list', {}, 'op');
		const rejected = expect(pending).rejects.toThrow('service closed');
		service.close();
		await rejected;
		service.setReady(true);
		await expect(service.execute('threads_list', {}, 'op')).rejects.toThrow('has closed');
	});

	it('bounds concurrent requests rather than growing its pending registry without a limit', async () => {
		const { service, requests } = fixture();
		const pending = Array.from({ length: 128 }, (_, index) =>
			service.execute('threads_wait', {}, `op-${index}`),
		);
		await expect(service.execute('threads_wait', {}, 'overflow')).rejects.toThrow('Too many');
		for (const item of requests) service.settle(item.id, { ok: true, result: null });
		await Promise.all(pending);
	});
});

describe('bot task transport validation', () => {
	it('returns detached JSON and permits all supported task names without hidden envelope fields', () => {
		const input = request({ nested: { title: 'Before' } });
		const result = validateBotTaskRequest(input);
		(input.arguments.nested as { title: string }).title = 'After';
		expect(result.arguments.nested).toEqual({ title: 'Before' });
		expect(() => validateBotTaskRequest({ ...input, apiKey: 'secret' })).toThrow('Invalid');
		expect(() => validateBotTaskRequest({ ...input, operationId: '' })).toThrow('Invalid');
	});

	it('measures UTF-8 bytes and rejects values that cannot survive JSON transport', () => {
		expect(() =>
			validateBotTaskRequest(request({ content: '🙂'.repeat(MAX_BOT_TASK_REQUEST_BYTES / 4) })),
		).toThrow('transport limit');
		for (const value of [undefined, NaN, Infinity, new Date(), () => null, 1n])
			expect(() => validateBotTaskRequest(request({ content: value }))).toThrow('JSON values');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => validateBotTaskRequest(request(cyclic))).toThrow('cycles');
		let deep: Record<string, unknown> = {};
		for (let index = 0; index < 30; index++) deep = { child: deep };
		expect(() => validateBotTaskRequest(request(deep))).toThrow('nested too deeply');
	});

	it('requires explicit successful results or nonempty bounded error strings', () => {
		expect(validateBotTaskResponse({ ok: true, result: { messages: [] } })).toEqual({
			ok: true,
			result: { messages: [] },
		});
		for (const invalid of [
			{ ok: true },
			{ ok: false, error: '' },
			{ ok: false, error: 'x'.repeat(2001) },
			{ ok: true, result: null, apiKey: 'secret' },
		])
			expect(() => validateBotTaskResponse(invalid)).toThrow('Invalid bot task');
	});

	it('does not allow custom timeouts to exceed the host deadline', () => {
		for (const timeoutMs of [0, -1, Infinity, NaN, 90_001])
			expect(() => new RendererTaskBridge({ deliver: () => undefined, timeoutMs })).toThrow(
				'timeout',
			);
	});
});
