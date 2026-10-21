import { useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '../types';
import type {
	PluginSurfaceBinding,
	PluginSurfaceBridge,
	PluginSurfaceSession,
} from '../plugin-surface-types';
import { PluginSurfaceController } from '../lib/plugin-surface-controller';
import { pluginConversationContext } from '../lib/plugin-conversation-context';

interface Options {
	enabled: boolean;
	workspaceId: string;
	composerId: string;
	mode: 'chat' | 'code';
	thread?: Thread;
	model?: PluginSurfaceBinding['model'];
	theme: 'light' | 'dark' | 'system';
	running: boolean;
}

/** Transport only: scheduling, inference prompts, and presentation belong to the plugin. */
export function usePluginSurfaceHost(options: Options) {
	const latest = useRef(options);
	latest.current = options;
	const [reload, setReload] = useState(0);
	const [systemDark, setSystemDark] = useState(
		() => matchMedia('(prefers-color-scheme: dark)').matches,
	);
	useEffect(() => {
		const media = matchMedia('(prefers-color-scheme: dark)');
		const change = () => setSystemDark(media.matches);
		media.addEventListener('change', change);
		const refresh = () => setReload((value) => value + 1);
		window.addEventListener('freelm:plugins-changed', refresh);
		return () => {
			media.removeEventListener('change', change);
			window.removeEventListener('freelm:plugins-changed', refresh);
		};
	}, []);
	const theme = options.theme === 'system' ? (systemDark ? 'dark' : 'light') : options.theme;
	const scope = JSON.stringify([
		options.workspaceId,
		options.composerId,
		options.thread?.id,
		options.mode,
		options.model,
		theme,
		reload,
	]);
	const path = options.thread?.messages.map((message) => message.id) ?? [];
	const branch = useRef({ scope, path, epoch: 0 });
	if (branch.current.scope !== scope) branch.current = { scope, path, epoch: 0 };
	else {
		if (!branch.current.path.every((id, index) => path[index] === id)) branch.current.epoch++;
		branch.current.path = path;
	}
	const branchEpoch = branch.current.epoch;
	const controller = useMemo(() => new PluginSurfaceController(), [scope, branchEpoch]);
	const activeController = useRef(controller);
	activeController.current = controller;
	const broadcast = useRef<(name: string, payload: Record<string, unknown>) => void>(() => {});
	useEffect(() => {
		const partial = window.desktop;
		if (!options.enabled || !partial?.pluginSurfaceOpen || !partial.onPluginSurfaceCall) return;
		const bridge = partial as typeof partial & PluginSurfaceBridge;
		let current = true;
		const sessions = new Map<string, PluginSurfaceSession>();
		const binding: PluginSurfaceBinding = {
			id: crypto.randomUUID(),
			composerId: options.composerId,
			workspaceId: options.workspaceId,
			threadId: options.thread?.id,
			surface: { kind: 'home', mode: options.mode },
			model: options.model,
			theme,
		};
		const send = (name: string, payload: Record<string, unknown>) => {
			if (!current) return;
			for (const session of sessions.values()) {
				if (name === 'contribution.dismissed' && payload.owner !== session.id) continue;
				const { owner: _owner, ...event } = payload;
				void bridge.pluginSurfaceEvent(session.id, name, event).catch(() => {});
			}
		};
		broadcast.current = send;
		const removeCalls = bridge.onPluginSurfaceCall((call) => {
			if (!current || call.bindingId !== binding.id) return;
			if (call.method === '$disposed') {
				controller.removeOwner(call.sessionId);
				sessions.delete(call.sessionId);
				return;
			}
			if (call.method === '$error') {
				console.warn('Plugin surface:', call.args.message);
				return;
			}
			if (!sessions.has(call.sessionId)) return;
			void (async () => {
				try {
					if (
						activeController.current !== controller ||
						latest.current.workspaceId !== binding.workspaceId ||
						latest.current.thread?.id !== binding.threadId ||
						!latest.current.enabled
					)
						throw new Error('The plugin conversation changed.');
					const result =
						call.method === 'conversation.getTurns'
							? pluginConversationContext(
									latest.current.thread,
									Number(call.args.limit),
									latest.current.running,
								)
							: await controller.execute(call.sessionId, call.method, call.args);
					await bridge.pluginSurfaceReply(call.sessionId, call.requestId, { result });
				} catch (error) {
					await bridge
						.pluginSurfaceReply(call.sessionId, call.requestId, {
							error: error instanceof Error ? error.message : 'Plugin UI operation failed.',
						})
						.catch(() => {});
				}
			})();
		});
		const removeEvents = controller.onEvent(send);
		const removeCommands = controller.onCommand((owner, id, payload) => {
			void bridge
				.pluginSurfaceCommand(owner, id, payload)
				.catch((error) => console.warn('Plugin command:', error));
		});
		controller.setViewCaller((owner, method, args) =>
			bridge.pluginSurfaceViewCall(owner, method, args),
		);
		void bridge
			.pluginSurfaceOpen(binding)
			.then(async ({ sessions: opened }) => {
				if (!current) {
					await bridge.pluginSurfaceClose(opened.map((session) => session.id));
					return;
				}
				for (const session of opened) {
					sessions.set(session.id, session);
					controller.addOwner(session.id);
				}
				await bridge.pluginSurfaceActivate(opened.map((session) => session.id));
				if (current) send('composer.stateChanged', { ...controller.getState() });
			})
			.catch((error) => {
				if (current) console.warn('Plugin activation:', error);
			});
		return () => {
			current = false;
			if (broadcast.current === send) broadcast.current = () => {};
			removeCalls();
			removeEvents();
			removeCommands();
			for (const id of sessions.keys()) controller.removeOwner(id);
			void bridge.pluginSurfaceClose([...sessions.keys()]).catch(() => {});
		};
	}, [controller, options.enabled]);

	const previous = useRef({ controller, running: options.running, completed: '' });
	useEffect(() => {
		const last = options.thread?.messages.at(-1);
		const completed =
			!options.running &&
			last?.role === 'assistant' &&
			!last.error &&
			!last.interrupted &&
			last.content.trim()
				? last.id
				: '';
		const prior = previous.current;
		previous.current = { controller, running: options.running, completed };
		if (prior.controller !== controller) return;
		if (options.running && !prior.running)
			broadcast.current('conversation.changed', { revision: controller.getState().revision });
		if (completed && completed !== prior.completed)
			broadcast.current('conversation.completed', {
				revision: controller.getState().revision,
				messageId: completed,
			});
	}, [controller, options.thread?.messages, options.running]);
	return controller;
}
