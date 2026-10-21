import { useEffect, useRef } from 'react';
import type { BotTaskRequest } from '../bot-task-types';

/** Keep bot requests in the same writer and runner as visible Chat/Code turns. */
export function useBotTaskBridge(
	ready: boolean,
	execute: (request: BotTaskRequest, signal: AbortSignal) => Promise<unknown>,
) {
	const handler = useRef(execute);
	handler.current = execute;
	const available = useRef(ready);
	available.current = ready;
	const pending = useRef(new Map<string, AbortController>());
	useEffect(() => {
		const bridge = window.desktop;
		if (!bridge?.onBotTaskRequest || !bridge.botTaskResult) return;
		const removeRequest = bridge.onBotTaskRequest((request) => {
			if (pending.current.has(request.id)) return;
			const controller = new AbortController();
			pending.current.set(request.id, controller);
			void (async () => {
				try {
					if (!available.current)
						throw new Error('Open this computer’s workspace in FreeLM to manage its threads.');
					const result = await handler.current(request, controller.signal);
					if (!controller.signal.aborted)
						await bridge.botTaskResult!(request.id, {
							ok: true,
							result: JSON.parse(JSON.stringify(result)),
						});
				} catch (error) {
					if (!controller.signal.aborted)
						await bridge.botTaskResult!(request.id, {
							ok: false,
							error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
						}).catch(() => {});
				} finally {
					pending.current.delete(request.id);
				}
			})();
		});
		const removeCancel = bridge.onBotTaskCancel?.((id) => pending.current.get(id)?.abort());
		return () => {
			removeRequest();
			removeCancel?.();
			for (const controller of pending.current.values()) controller.abort();
			pending.current.clear();
			void bridge.botTasksReady?.(false).catch(() => {});
		};
	}, []);
	useEffect(() => {
		if (!ready) for (const controller of pending.current.values()) controller.abort();
		void window.desktop?.botTasksReady?.(ready).catch(() => {});
	}, [ready]);
}
