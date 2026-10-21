import type { DesktopBridge, WireRequest, WireResponse } from '../src/types';
import type { StreamEvent } from './stream-protocol';

// Starts only after the network request has finished. Cold-start/API deadlines are separate.
export const STREAM_DRAIN_TIMEOUT_MS = 30_000;
type ChunkListener = Parameters<DesktopBridge['onChunk']>[0];
interface PendingStream {
	token: string;
	resolve: (response: WireResponse) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** One receiver delivers chunks and their terminal result in IPC send order. */
export function createStreamBridge(options: {
	invoke: (request: WireRequest, token: string) => Promise<unknown>;
	cancel: (id: string) => Promise<unknown>;
}) {
	const pending = new Map<string, PendingStream>();
	const listeners = new Set<ChunkListener>();
	function remove(id: string, entry: PendingStream) {
		if (pending.get(id) !== entry) return false;
		pending.delete(id);
		clearTimeout(entry.timer);
		return true;
	}
	function fail(id: string, entry: PendingStream, error: Error) {
		if (!remove(id, entry)) return false;
		entry.reject(error);
		return true;
	}
	function stopTransport(id: string) {
		void options.cancel(id).catch(() => {});
	}
	return {
		request(request: WireRequest): Promise<WireResponse> {
			if (pending.has(request.id))
				return Promise.reject(new Error('This request is already running.'));
			return new Promise((resolve, reject) => {
				const entry: PendingStream = { token: crypto.randomUUID(), resolve, reject };
				pending.set(request.id, entry);
				// Invoke is only an acknowledgement for streaming requests. Its reply may overtake
				// chunk IPC messages, so only the ordered terminal event can resolve the request.
				Promise.resolve()
					.then(() => {
						if (pending.get(request.id) !== entry) return;
						return options.invoke(request, entry.token);
					})
					.then(
						() => {
							if (pending.get(request.id) !== entry) return;
							entry.timer = setTimeout(() => {
								const failed = fail(
									request.id,
									entry,
									new Error(
										'The desktop stream did not deliver its final result. Retry this message.',
									),
								);
								if (failed) stopTransport(request.id);
							}, STREAM_DRAIN_TIMEOUT_MS);
						},
						(error: unknown) => {
							fail(
								request.id,
								entry,
								error instanceof Error ? error : new Error('The desktop request failed.'),
							);
						},
					);
			});
		},
		receive(value: StreamEvent) {
			if (!value || typeof value.id !== 'string' || typeof value.token !== 'string') return;
			const entry = pending.get(value.id);
			if (!entry || entry.token !== value.token) return;
			if (value.type === 'chunk' && typeof value.text === 'string') {
				let listenerFailed = false;
				for (const listener of [...listeners]) {
					try {
						listener({ id: value.id, text: value.text });
					} catch {
						listenerFailed = true;
					}
				}
				if (listenerFailed) {
					const failed = fail(
						value.id,
						entry,
						new Error('FreeLM could not process a desktop stream chunk. Retry this message.'),
					);
					if (failed) stopTransport(value.id);
				}
			} else if (value.type === 'complete') {
				if (remove(value.id, entry)) entry.resolve(value.response);
			} else if (value.type === 'error') {
				const error = new Error(value.error.message);
				error.name = value.error.name;
				fail(value.id, entry, error);
			}
		},
		cancel(id: string) {
			const entry = pending.get(id);
			if (!entry) return;
			const error = new Error('Request cancelled.');
			error.name = 'AbortError';
			fail(id, entry, error);
		},
		onChunk(listener: ChunkListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
