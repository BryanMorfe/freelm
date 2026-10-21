/** One implementation shared by the public UI module and the install-time compiler. */
export function createPluginUIBridge() {
	const hostGlobal = globalThis as typeof globalThis & { __freelmPluginNonce?: string };
	const nonce = hostGlobal.__freelmPluginNonce;
	delete hostGlobal.__freelmPluginNonce;
	const v1 = 'freelm-plugin-ui-v1', v2 = 'freelm-plugin-ui-v2';
	let sequence = 0, props: Record<string, unknown> = {};
	const propListeners = new Set<(props: Record<string, unknown>) => void>();
	const pending = new Map<string, { protocol: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	window.addEventListener('message', event => {
		const message = event.data;
		if (event.source !== parent || !message || message.nonce !== nonce || ![v1, v2].includes(message.protocol)) return;
		if (message.protocol === v2 && message.event === 'props') {
			if (!message.props || typeof message.props !== 'object' || Array.isArray(message.props)) return;
			const encoded = JSON.stringify(message.props);
			if (encoded.length > 64_000) return;
			props = JSON.parse(encoded);
			for (const listener of propListeners) listener(structuredClone(props));
			return;
		}
		const entry = pending.get(message.id);
		if (!entry || entry.protocol !== message.protocol) return;
		pending.delete(message.id); clearTimeout(entry.timer);
		typeof message.error === 'string' ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
	});
	function request(protocol: string, field: 'action' | 'method', name: string, args: Record<string, unknown> = {}) {
		return new Promise<unknown>((resolve, reject) => {
			if (!nonce || parent === window) { reject(new Error('Open this view inside FreeLM.')); return; }
			if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args) || pending.size >= 8) {
				reject(new Error('Invalid or busy plugin UI request.')); return;
			}
			let payload;
			try {
				const encoded = JSON.stringify(args);
				if (encoded.length > 64_000) throw new Error('Plugin UI request exceeds 64 KB.');
				payload = JSON.parse(encoded);
			} catch (error) { reject(error); return; }
			const id = 'ui-' + (++sequence);
			// Inference has a separate I/O allowance from ordinary UI actions.
			const timer = setTimeout(() => { pending.delete(id); reject(new Error('Plugin UI request timed out.')); }, name === 'inference.generateText' ? 30 * 60 * 1000 : 30_000);
			pending.set(id, { protocol, resolve, reject, timer });
			parent.postMessage({ protocol, nonce, id, [field]: name, args: payload }, '*');
		});
	}
	if (nonce && parent !== window) parent.postMessage({ protocol: v2, nonce, event: 'ready' }, '*');
	return {
		invoke: (action: string, args: Record<string, unknown> = {}) => request(v1, 'action', action, args),
		call: (method: string, args: Record<string, unknown> = {}) => request(v2, 'method', method, args),
		runCommand: (id: string, payload: Record<string, unknown> = {}) => request(v2, 'method', 'commands.run', { id, payload }),
		getViewProps: () => structuredClone(props),
		onViewPropsChanged: (listener: (props: Record<string, unknown>) => void) => {
			if (typeof listener !== 'function') throw new TypeError('Expected a props listener.');
			propListeners.add(listener);
			return { dispose: () => { propListeners.delete(listener); } };
		},
	};
}
