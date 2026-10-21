import { useEffect, useRef } from 'react';
import { ArrowRightToLine, FileText, Paperclip, Puzzle, X } from 'lucide-react';
import type {
	PluginSurfaceController,
	PluginSurfacePresentation,
} from '../lib/plugin-surface-controller';
import './plugin-composer.css';
const icons = { 'file-text': FileText, paperclip: Paperclip };
export function PluginComposerDrawer({
	controller,
	items,
}: {
	controller?: PluginSurfaceController;
	items: PluginSurfacePresentation['drawer'];
}) {
	if (!controller || !items.length) return null;
	return (
		<>
			{items.map((item) => {
				if (item.view)
					return (
						<PluginDrawerView
							key={`${item.owner}:${item.id}`}
							controller={controller}
							item={item}
						/>
					);
				const Icon = icons[item.icon as keyof typeof icons] || Puzzle;
				return (
					<div
						className="plugin-composer-drawer-row"
						key={`${item.owner}:${item.id}`}
						data-plugin-contribution={item.id}
					>
						<Icon size={17} aria-hidden="true" />
						<div className="plugin-composer-drawer-copy">
							<span>{item.title}</span>
							{item.description && (
								<span className="plugin-composer-drawer-description">{item.description}</span>
							)}
							{item.progress !== undefined && (
								<progress max={1} value={item.progress} aria-label={`${item.title} progress`} />
							)}
						</div>
						<div className="plugin-composer-drawer-actions">
							{item.actions?.map((action) => (
								<button
									type="button"
									className="text-button"
									key={action.command}
									onClick={() => controller.invokeCommand(item.owner, action.command)}
								>
									{action.title}
								</button>
							))}
							{item.dismissible && (
								<button
									type="button"
									className="icon-button"
									aria-label={`Dismiss ${item.title}`}
									onClick={() => controller.dismissDrawer(item.owner, item.id)}
								>
									<X size={15} />
								</button>
							)}
						</div>
					</div>
				);
			})}
		</>
	);
}
export function PluginPlaceholderAction({
	controller,
	placeholder,
}: {
	controller?: PluginSurfaceController;
	placeholder: PluginSurfacePresentation['placeholder'];
}) {
	if (!controller || !placeholder?.acceptCommand) return null;
	return (
		<button
			type="button"
			className="plugin-composer-placeholder-action"
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => controller.invokeCommand(placeholder.owner, placeholder.acceptCommand!)}
		>
			{placeholder.acceptKey?.toLowerCase() === 'tab' && (
				<ArrowRightToLine size={15} aria-hidden="true" />
			)}
			{placeholder.hint || 'Use this text'}
		</button>
	);
}

function PluginDrawerView({
	controller,
	item,
}: {
	controller: PluginSurfaceController;
	item: PluginSurfacePresentation['drawer'][number];
}) {
	const iframe = useRef<HTMLIFrameElement>(null);
	const view = item.view!;
	const props = useRef(view.props);
	props.current = view.props;
	const sendProps = () =>
		iframe.current?.contentWindow?.postMessage(
			{
				protocol: 'freelm-plugin-ui-v2',
				nonce: view.nonce,
				event: 'props',
				props: props.current ?? {},
			},
			'*',
		);
	useEffect(() => {
		sendProps();
	}, [view.props]);
	useEffect(() => {
		let active = true;
		const pending = new Set<string>();
		const receive = (event: MessageEvent) => {
			const target = iframe.current?.contentWindow;
			const message = event.data;
			if (
				target &&
				event.source === target &&
				message?.protocol === 'freelm-plugin-ui-v2' &&
				message.nonce === view.nonce &&
				message.event === 'ready'
			) {
				sendProps();
				return;
			}
			if (
				!target ||
				event.source !== target ||
				!message ||
				message.protocol !== 'freelm-plugin-ui-v2' ||
				message.nonce !== view.nonce ||
				typeof message.id !== 'string' ||
				!message.id ||
				message.id.length > 128
			)
				return;
			if (pending.has(message.id)) return;
			const reply = (payload: { result: unknown } | { error: string }) => {
				if (active && target === iframe.current?.contentWindow)
					target.postMessage(
						{ protocol: 'freelm-plugin-ui-v2', nonce: view.nonce, id: message.id, ...payload },
						'*',
					);
			};
			if (pending.size >= 16) {
				reply({ error: 'Too many pending view calls.' });
				return;
			}
			if (message.method === 'view.getProps') {
				reply({ result: props.current ?? {} });
				return;
			}
			if (
				typeof message.method !== 'string' ||
				message.method.length > 120 ||
				!message.args ||
				typeof message.args !== 'object' ||
				Array.isArray(message.args)
			) {
				reply({ error: 'Invalid view call.' });
				return;
			}
			let args: Record<string, unknown>;
			try {
				const encoded = JSON.stringify(message.args);
				if (encoded.length > 64_000) throw new Error();
				args = JSON.parse(encoded);
			} catch {
				reply({ error: 'View arguments must fit within 64 KB.' });
				return;
			}
			pending.add(message.id);
			void controller
				.callView(item.owner, message.method, args)
				.then(
					(result) => reply({ result }),
					(error) =>
						reply({ error: error instanceof Error ? error.message : 'The view call failed.' }),
				)
				.finally(() => pending.delete(message.id));
		};
		window.addEventListener('message', receive);
		return () => {
			active = false;
			window.removeEventListener('message', receive);
		};
	}, [controller, item.owner, view.nonce]);
	return (
		<iframe
			className="plugin-composer-view"
			ref={iframe}
			title={item.title}
			src={view.url}
			style={{ height: view.height }}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			onLoad={sendProps}
		/>
	);
}
