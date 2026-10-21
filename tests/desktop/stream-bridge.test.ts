import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamBridge, STREAM_DRAIN_TIMEOUT_MS } from '../../electron/stream-bridge';
import type { WireRequest, WireResponse } from '../../src/types';

const request: WireRequest = {
	id: 'stream-test',
	baseUrl: 'http://localhost/v1',
	apiKey: '',
	path: '/responses',
	method: 'POST',
	stream: true,
};
const response: WireResponse = {
	status: 200,
	contentType: 'text/event-stream',
	body: '',
	encoding: 'text',
};
const tick = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(
	invoke = vi.fn(async (_request: WireRequest, _token: string): Promise<unknown> => null),
) {
	const cancel = vi.fn(async () => {});
	const bridge = createStreamBridge({ invoke, cancel });
	const token = (index = 0) => invoke.mock.calls[index][1];
	return { bridge, invoke, cancel, token };
}
afterEach(() => {
	vi.useRealTimers();
});

describe('ordered desktop stream delivery', () => {
	it.each(['resolve', 'reject'] as const)(
		'settles from a terminal event before invoke can %s, without leaving a drain timer',
		async (settlement) => {
			vi.useFakeTimers();
			let acknowledge!: () => void;
			let rejectInvoke!: (error: Error) => void;
			const { bridge, token } = fixture(
				vi.fn(
					() =>
						new Promise<void>((resolve, reject) => {
							acknowledge = resolve;
							rejectInvoke = reject;
						}),
				),
			);
			const result = bridge.request(request);
			await tick();
			bridge.receive({ type: 'complete', id: request.id, token: token(), response });
			await expect(result).resolves.toEqual(response);
			if (settlement === 'resolve') acknowledge();
			else rejectInvoke(new Error('Late invoke failure'));
			await tick();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('does not finish on invoke acknowledgement before a late tail over 64KB arrives', async () => {
		const { bridge, token } = fixture();
		const chunks: string[] = [];
		bridge.onChunk(({ text }) => chunks.push(text));
		let finished = false;
		const result = bridge.request(request).then((value) => {
			finished = true;
			return value;
		});
		await tick();
		const prefix = 'a'.repeat(65533);
		bridge.receive({ type: 'chunk', id: request.id, token: token(), text: prefix });
		await tick();
		expect(finished).toBe(false);
		const tail = 'data: {"type":"response.completed"}\n\n';
		bridge.receive({ type: 'chunk', id: request.id, token: token(), text: tail });
		bridge.receive({ type: 'complete', id: request.id, token: token(), response });
		expect(await result).toEqual(response);
		expect(chunks.join('')).toBe(prefix + tail);
	});

	it('delivers partial data before an ordered transport error even if invoke acknowledged first', async () => {
		const { bridge, token } = fixture();
		const chunks: string[] = [];
		bridge.onChunk(({ text }) => chunks.push(text));
		const result = bridge.request(request);
		const assertion = expect(result).rejects.toThrow('Invalid UTF-8');
		await tick();
		bridge.receive({ type: 'chunk', id: request.id, token: token(), text: 'partial' });
		bridge.receive({
			type: 'error',
			id: request.id,
			token: token(),
			error: { name: 'ResponseDecodingError', message: 'Invalid UTF-8' },
		});
		await assertion;
		expect(chunks).toEqual(['partial']);
	});

	it('rejects preflight failures without waiting for a terminal marker', async () => {
		const { bridge } = fixture(
			vi.fn(async () => {
				throw new Error('Untrusted request.');
			}),
		);
		await expect(bridge.request(request)).rejects.toThrow('Untrusted request.');
	});

	it('cancels immediately and ignores late chunks and terminal results from the canceled invocation', async () => {
		const { bridge, token } = fixture();
		const onChunk = vi.fn();
		bridge.onChunk(onChunk);
		const old = bridge.request(request);
		const assertion = expect(old).rejects.toMatchObject({ name: 'AbortError' });
		await tick();
		const oldToken = token();
		bridge.cancel(request.id);
		await assertion;
		const next = bridge.request(request);
		await tick();
		bridge.receive({ type: 'chunk', id: request.id, token: oldToken, text: 'stale' });
		bridge.receive({ type: 'complete', id: request.id, token: oldToken, response });
		expect(onChunk).not.toHaveBeenCalled();
		bridge.receive({ type: 'chunk', id: request.id, token: token(1), text: 'fresh' });
		bridge.receive({ type: 'complete', id: request.id, token: token(1), response });
		await expect(next).resolves.toEqual(response);
		expect(onChunk).toHaveBeenCalledExactlyOnceWith({ id: request.id, text: 'fresh' });
	});

	it('does not start a network request canceled before invocation', async () => {
		const { bridge, invoke } = fixture();
		const result = bridge.request(request);
		const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
		bridge.cancel(request.id);
		await assertion;
		expect(invoke).not.toHaveBeenCalled();
	});

	it('rejects duplicate IDs without disrupting the original request', async () => {
		const { bridge, token } = fixture();
		const first = bridge.request(request);
		await expect(bridge.request(request)).rejects.toThrow('already running');
		bridge.receive({ type: 'complete', id: request.id, token: token(), response });
		await expect(first).resolves.toEqual(response);
	});

	it('isolates concurrent requests and cleans listeners when unsubscribed', async () => {
		const { bridge, token } = fixture();
		const onChunk = vi.fn();
		const unsubscribe = bridge.onChunk(onChunk);
		const first = bridge.request(request);
		const secondId = 'second-request';
		const second = bridge.request({ ...request, id: secondId });
		await tick();
		bridge.receive({ type: 'chunk', id: secondId, token: token(1), text: 'second' });
		bridge.receive({ type: 'complete', id: secondId, token: token(1), response });
		await second;
		unsubscribe();
		bridge.receive({ type: 'chunk', id: request.id, token: token(), text: 'first' });
		bridge.receive({ type: 'complete', id: request.id, token: token(), response });
		await first;
		expect(onChunk).toHaveBeenCalledExactlyOnceWith({ id: secondId, text: 'second' });
	});

	it('waits through a long model startup, then bounds missing local delivery after acknowledgement', async () => {
		vi.useFakeTimers();
		let acknowledge!: () => void;
		const { bridge, cancel } = fixture(
			vi.fn(
				() =>
					new Promise<void>((resolve) => {
						acknowledge = resolve;
					}),
			),
		);
		const result = bridge.request(request);
		const assertion = expect(result).rejects.toThrow('did not deliver its final result');
		await tick();
		await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
		expect(cancel).not.toHaveBeenCalled();
		acknowledge();
		await tick();
		await vi.advanceTimersByTimeAsync(STREAM_DRAIN_TIMEOUT_MS);
		await assertion;
		expect(cancel).toHaveBeenCalledWith(request.id);
	});

	it('cleans the drain timer when terminal delivery succeeds', async () => {
		vi.useFakeTimers();
		const { bridge, cancel, token } = fixture();
		const result = bridge.request(request);
		await tick();
		bridge.receive({ type: 'complete', id: request.id, token: token(), response });
		await result;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(STREAM_DRAIN_TIMEOUT_MS);
		expect(cancel).not.toHaveBeenCalled();
	});

	it('surfaces callback failures and keeps them from breaking other stream listeners', async () => {
		const { bridge, cancel, token } = fixture();
		bridge.onChunk(() => {
			throw new Error('Private response contents');
		});
		const onChunk = vi.fn();
		bridge.onChunk(onChunk);
		const result = bridge.request(request);
		const assertion = expect(result).rejects.toThrow('could not process a desktop stream chunk');
		await tick();
		bridge.receive({ type: 'chunk', id: request.id, token: token(), text: 'received' });
		await assertion;
		expect(onChunk).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledWith(request.id);
	});
});
