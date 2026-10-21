import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolCallRecord } from '../agent-types';
import { codeBrowserLink } from './code-surface-context';

export interface WorkspaceTab {
	id: string;
	kind: 'files' | 'file' | 'browser' | 'changes';
	title: string;
	path?: string;
	url?: string;
	line?: number;
	calls?: readonly ToolCallRecord[];
	threadId?: string;
}
interface TabGroup {
	tabs: WorkspaceTab[];
	active?: string;
	open: boolean;
	expanded: boolean;
	notice?: string;
}
const empty = (): TabGroup => ({ tabs: [], open: false, expanded: false });
const storageKey = 'freelm-code-workspace-tabs-v1';
function restored(): Record<string, TabGroup> {
	try {
		const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
		const result: Record<string, TabGroup> = {};
		for (const [scope, raw] of Object.entries(data).slice(0, 32)) {
			const group = raw as TabGroup;
			if (!Array.isArray(group?.tabs)) continue;
			const tabs = group.tabs
				.filter(
					(t) =>
						typeof t.id === 'string' &&
						t.id.length < 100 &&
						['files', 'file', 'browser', 'changes'].includes(t.kind) &&
						typeof t.title === 'string' &&
						(!t.path || typeof t.path === 'string'),
				)
				.slice(0, 12)
				.map((t) => ({
					id: t.id,
					kind: t.kind,
					title: t.title.slice(0, 120),
					path: t.path?.slice(0, 4096),
					url:
						t.kind === 'browser' && typeof t.url === 'string' ? codeBrowserLink(t.url) : undefined,
				}));
			result[scope] = {
				tabs,
				active: tabs.find((t) => t.id === group.active)?.id || tabs[0]?.id,
				open: group.open === true,
				expanded: false,
			};
		}
		return result;
	} catch {
		return {};
	}
}
export function useCodeWorkspaceTabs(scope: string, threadId?: string) {
	const [groups, setGroups] = useState<Record<string, TabGroup>>(restored);
	const group = groups[scope] || empty();
	const update = useCallback(
		(change: (value: TabGroup) => TabGroup) =>
			setGroups((all) => {
				const current = all[scope] || empty();
				const next = change(current);
				return next === current ? all : { ...all, [scope]: next };
			}),
		[scope],
	);
	useEffect(() => {
		const timer = setTimeout(() => {
			try {
				localStorage.setItem(
					storageKey,
					JSON.stringify(
						Object.fromEntries(
							Object.entries(groups)
								.slice(-32)
								.map(([key, g]) => [key, { ...g, tabs: g.tabs.map(({ calls, ...tab }) => tab) }]),
						),
					),
				);
			} catch {}
		}, 200);
		return () => clearTimeout(timer);
	}, [groups]);
	const add = useCallback(
		(
			kind: WorkspaceTab['kind'],
			path?: string,
			line?: number,
			calls?: readonly ToolCallRecord[],
			url?: string,
		) => {
			update((g) => {
				const existing = g.tabs.find((t) =>
					kind === 'browser'
						? !!url && t.kind === kind && t.url === url
						: t.kind === kind && t.path === path,
				);
				if (kind === 'browser' && existing)
					return { ...g, open: true, active: existing.id, notice: undefined };
				const tab: WorkspaceTab = {
					id: existing?.id || crypto.randomUUID(),
					kind,
					title:
						kind === 'file'
							? path!.split('/').pop() || path!
							: kind === 'files'
								? 'Files'
								: kind === 'browser'
									? 'New tab'
									: 'Changes',
					path,
					url,
					line,
					calls,
					threadId: kind === 'changes' ? threadId : undefined,
				};
				// Preserve existing tabs and their pending annotations at the visible limit.
				if (!existing && g.tabs.length >= 12)
					return {
						...g,
						open: true,
						notice: 'Close a workspace tab to open this link (12 tabs maximum).',
					};
				return {
					...g,
					open: true,
					notice: undefined,
					active: tab.id,
					tabs: existing ? g.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...g.tabs, tab],
				};
			});
		},
		[update, threadId],
	);
	return {
		...group,
		scope,
		groups,
		add,
		toggle: () => {
			if (!group.tabs.length) add('files');
			else update((g) => ({ ...g, open: !g.open, expanded: false }));
		},
		select: (id: string) => update((g) => ({ ...g, active: id })),
		close: (id: string) =>
			update((g) => {
				const tabs = g.tabs.filter((t) => t.id !== id);
				return {
					...g,
					tabs,
					notice: undefined,
					active:
						g.active === id
							? tabs[Math.max(0, g.tabs.findIndex((t) => t.id === id) - 1)]?.id
							: g.active,
					open: !!tabs.length && g.open,
				};
			}),
		rename: (id: string, title: string) =>
			update((g) =>
				g.tabs.find((t) => t.id === id)?.title === title
					? g
					: {
							...g,
							tabs: g.tabs.map((t) => (t.id === id ? { ...t, title: title.slice(0, 120) } : t)),
						},
			),
		setExpanded: (expanded: boolean) => update((g) => ({ ...g, expanded })),
		setBrowserUrl: (id: string, url: string) =>
			update((g) => {
				const normalized = codeBrowserLink(url);
				if (!normalized || g.tabs.find((t) => t.id === id)?.url === normalized) return g;
				return { ...g, tabs: g.tabs.map((t) => (t.id === id ? { ...t, url: normalized } : t)) };
			}),
		actions: useMemo(
			() => ({
				openFile: (path: string, line?: number) => add('file', path, line),
				openBrowser: (href: string) => {
					const url = codeBrowserLink(href);
					if (url) add('browser', undefined, undefined, undefined, url);
				},
				openChanges: (calls?: readonly ToolCallRecord[]) =>
					add('changes', undefined, undefined, calls),
			}),
			[add],
		),
	};
}
