import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	loadNavigationPreferences,
	saveNavigationPreferences,
} from '../lib/navigation-preferences';
import type {
	InstalledPlugin,
	PluginLocalManifest,
	PluginSnapshot,
	PluginTabDeclaration,
} from '../plugin-types';

export interface PluginTabChoice {
	key: string;
	plugin: InstalledPlugin & { manifest: PluginLocalManifest };
	tab: PluginTabDeclaration;
}
const emptySnapshot: PluginSnapshot = { plugins: [], accounts: [] };

function availableTabs(snapshot: PluginSnapshot): PluginTabChoice[] {
	return snapshot.plugins.flatMap((plugin) => {
		if (!plugin.enabled || !plugin.package || plugin.manifest.manifestVersion !== 2) return [];
		const local = plugin as InstalledPlugin & { manifest: PluginLocalManifest };
		return local.manifest.contributes.tabs.map((tab) => ({
			key: `${local.manifest.id}/${tab.id}`,
			plugin: local,
			tab,
		}));
	});
}

/** UI tabs are host-local and deliberately never enter persisted WorkspaceMode. */
export function usePluginTabs(enabled: boolean) {
	const [snapshot, setSnapshot] = useState<PluginSnapshot>(emptySnapshot);
	const [activeKey, setActiveKeyState] = useState<string | null>(
		() => loadNavigationPreferences().pluginKey,
	);
	const [ready, setReady] = useState(false);
	const activeKeyRef = useRef(activeKey);
	const setActiveKey = useCallback((key: string | null) => {
		activeKeyRef.current = key;
		setActiveKeyState(key);
		saveNavigationPreferences({ pluginKey: key });
	}, []);
	useEffect(() => {
		const bridge = window.desktop;
		setReady(false);
		if (
			!enabled ||
			!bridge?.pluginSnapshot ||
			!bridge.pluginTabContent ||
			!bridge.pluginInvokeAction
		) {
			setSnapshot(emptySnapshot);
			// Workspace loading and host transitions temporarily disable plugin tabs.
			// Only an actual snapshot can establish that a saved tab no longer exists.
			return;
		}
		let current = true;
		let request = 0;
		const refresh = () => {
			const version = ++request;
			void bridge.pluginSnapshot!()
				.then((next) => {
					if (!current || request !== version) return;
					setSnapshot(next);
					setReady(true);
					const key = activeKeyRef.current;
					if (key && !availableTabs(next).some((tab) => tab.key === key)) setActiveKey(null);
				})
				.catch(() => {
					if (current && request === version) {
						setSnapshot(emptySnapshot);
						setReady(true);
					}
				});
		};
		refresh();
		window.addEventListener('freelm:plugins-changed', refresh);
		window.addEventListener('focus', refresh);
		return () => {
			current = false;
			window.removeEventListener('freelm:plugins-changed', refresh);
			window.removeEventListener('focus', refresh);
		};
	}, [enabled, setActiveKey]);
	const tabs = useMemo<PluginTabChoice[]>(
		() => (!enabled ? [] : availableTabs(snapshot)),
		[enabled, snapshot],
	);
	const active = tabs.find((tab) => tab.key === activeKey);
	return {
		tabs,
		active,
		setActiveKey,
		accounts: snapshot.accounts,
		restoring: enabled && !ready && !!activeKey,
	};
}
