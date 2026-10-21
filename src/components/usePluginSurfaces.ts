import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type {
	PluginComposerAdapter,
	PluginSurfaceController,
	PluginSurfacePresentation,
} from '../lib/plugin-surface-controller';
const empty: PluginSurfacePresentation = { drawer: [] };
const noop = () => () => {};
const snapshot = () => empty;

/** Keep one activation binding across ordinary editor renders and draft changes. */
export function usePluginSurfaces(
	controller: PluginSurfaceController | undefined,
	adapter: PluginComposerAdapter,
) {
	const latest = useRef(adapter);
	latest.current = adapter;
	useLayoutEffect(() => {
		if (!controller) return;
		return controller.bind({
			state: () => latest.current.state(),
			readDraft: () => latest.current.readDraft(),
			getSelection: () => latest.current.getSelection(),
			applyEdit: (edit) => latest.current.applyEdit(edit),
			addAttachment: (attachment) => latest.current.addAttachment(attachment),
			readAttachments: () => latest.current.readAttachments(),
			removeAttachment: (index) => latest.current.removeAttachment(index),
		});
	}, [controller]);
	useLayoutEffect(() => controller?.notifyStateChanged());
	return useSyncExternalStore(
		controller?.subscribe ?? noop,
		controller?.getSnapshot ?? snapshot,
		snapshot,
	);
}
