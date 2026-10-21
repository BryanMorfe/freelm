import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Chat from '../src/components/Chat';
import Sidebar from '../src/components/Sidebar';
import type { AppState, Project, Thread } from '../src/types';
import { initialState } from '../src/lib/state';

const noop = () => {};
const chatProject: Project = {
	id: 'chat-project',
	name: 'Writing ideas',
	kind: 'chat',
	instructions: 'Keep a friendly tone.',
	createdAt: 1,
};
const codeProject: Project = {
	id: 'code-project',
	name: 'Desktop source',
	kind: 'code',
	instructions: 'Run focused tests.',
	directories: ['/fixture/source'],
	createdAt: 1,
};
const legacyCodeProject: Project = {
	id: 'legacy-project',
	name: 'Older source folder',
	instructions: '',
	directories: ['/fixture/legacy'],
	createdAt: 1,
};
function thread(id: string, title: string, extra: Partial<Thread> = {}): Thread {
	return {
		id,
		title,
		connectionId: 'provider',
		model: '',
		messages: [],
		createdAt: 1,
		updatedAt: 1,
		...extra,
	};
}
function state(): AppState {
	const value = initialState();
	return {
		...value,
		projects: [chatProject, codeProject, legacyCodeProject],
		threads: [
			thread('chat-thread', 'Discuss a weekend trip', { kind: 'chat', projectId: chatProject.id }),
			thread('code-thread', 'Implement the parser', { kind: 'code', projectId: codeProject.id }),
			thread('legacy-thread', 'Inspect older files', { projectId: legacyCodeProject.id }),
			thread('mixed-thread', 'Historical coding task', { kind: 'code', projectId: chatProject.id }),
		],
	};
}
function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
	return renderToStaticMarkup(
		createElement(Sidebar, {
			state: state(),
			collapsed: false,
			mode: 'chat',
			threadId: null,
			projectId: null,
			onMode: noop,
			onThread: noop,
			onNewChat: noop,
			onProject: noop,
			onNewProject: noop,
			onEditProject: noop,
			onThreadAction: noop,
			onSettings: noop,
			onSearch: noop,
			...overrides,
		}),
	);
}
function renderChat(overrides: Partial<ComponentProps<typeof Chat>> = {}) {
	const connection = state().connections[0];
	return renderToStaticMarkup(
		createElement(Chat, {
			connection,
			model: '',
			thinkingMode: '',
			onThinkingMode: noop,
			busy: false,
			runningHere: false,
			onModel: noop,
			onSend: noop,
			onStop: noop,
			onRetry: noop,
			onSettings: noop,
			onToolsSettings: noop,
			onPermissionMode: noop,
			onEditProject: noop,
			onNewProject: noop,
			onMove: noop,
			projects: state().projects,
			...overrides,
		}),
	);
}
afterEach(() => vi.unstubAllGlobals());

describe('separate Chat and Code destinations', () => {
	it('shows plain Chat projects and history without Code or legacy folder-bound items', () => {
		const html = renderSidebar();
		expect(html).toContain('aria-label="Workspaces"');
		expect(html).toContain('aria-label="Home"');
		expect(html).toContain('aria-label="Conversation mode"');
		expect(html).toContain('New chat');
		expect(html).toContain('Search chats');
		expect(html).toContain('Writing ideas');
		expect(html).toContain('Discuss a weekend trip');
		for (const text of [
			'Desktop source',
			'Older source folder',
			'Implement the parser',
			'Inspect older files',
			'Historical coding task',
		])
			expect(html).not.toContain(text);
	});
	it('shows Code projects and tasks, including migrated tasks with a Chat project', () => {
		const html = renderSidebar({ mode: 'code', projectId: chatProject.id });
		expect(html).toContain('New task');
		expect(html).toContain('Search tasks');
		expect(html).toContain('Recents');
		for (const text of [
			'Desktop source',
			'Older source folder',
			'Implement the parser',
			'Inspect older files',
			'Historical coding task',
		])
			expect(html).toContain(text);
		expect(html).not.toContain('Discuss a weekend trip');
		expect(html).not.toContain('Writing ideas');
	});
	it('retains Code project groups and recent tasks while visiting a media playground', () => {
		const html = renderSidebar({
			mode: 'images',
			conversationKind: 'code',
			projectId: codeProject.id,
		});
		expect(html).toContain('New task');
		expect(html).toContain('Recents');
		expect(html).toContain('Implement the parser');
		expect(html).toContain('Inspect older files');
		expect(html).not.toContain('Discuss a weekend trip');
	});
});

describe('conversation composer surfaces', () => {
	it('keeps Chat focused on messages and project instructions even with tools configured', () => {
		const html = renderChat({
			project: { ...chatProject, directories: ['/fixture/hidden-in-chat'] },
			toolsEnabled: true,
		});
		expect(html).toContain('How can I help with Writing ideas?');
		expect(html).not.toContain('Project instructions active');
		expect(html).not.toContain('aria-label="Chat project"');
		for (const text of [
			'Open tool settings',
			'Tools enabled',
			'Edit folders',
			'/fixture/hidden-in-chat',
			'Desktop source',
			'Write some code',
			'aria-label="Code permissions"',
			'aria-label="Code execution host"',
		])
			expect(html).not.toContain(text);
	});
	it('keeps a new Code task minimal while describing browser execution limits', () => {
		const html = renderChat({ conversationKind: 'code', toolsEnabled: true });
		expect(html).toContain('What should we work on?');
		expect(html).toContain('Running tools requires the desktop app.');
		expect(html).toContain('aria-label="Code project"');
		expect(html).toContain('Choose project');
		expect(html).toContain('aria-label="Code execution host"');
		expect(html).toContain('This computer');
		expect(html).toMatch(/<button[^>]*aria-label="Code permissions"[^>]*disabled=""/);
		expect(html).toContain('Ask for approval');
		for (const text of [
			'code-project-setup',
			'Create a Code project',
			'Open tool settings',
			'Tools on',
			'Build a feature',
			'class="suggestions"',
		])
			expect(html).not.toContain(text);
		expect(html).not.toContain('Writing ideas');
	});
	it('names the Code project and shows the chosen permission mode beside the shared model picker', () => {
		vi.stubGlobal('window', { desktop: { toolExecute: noop } });
		const html = renderChat({
			conversationKind: 'code',
			project: codeProject,
			toolsEnabled: true,
			permissionMode: 'auto-review',
		});
		expect(html).toContain('What should we work on in Desktop source?');
		expect(html).toContain('title="Desktop source\n/fixture/source"');
		expect(html).toContain('aria-label="Clear project"');
		expect(html).toContain('data-permission-mode="auto-review"');
		expect(html).toContain('Approve for me');
		expect(html).toContain('aria-label="Chat model"');
		expect(html).not.toMatch(/<button[^>]*aria-label="Code permissions"[^>]*disabled=""/);
		expect(html).not.toContain('Tools on');
		expect(html).not.toContain('Code tools are disabled.');
		expect(html).not.toContain('Open the desktop app');
	});
	it('clears incompatible Chat project context when composing a Code task', () => {
		const otherChat: Project = { ...chatProject, id: 'other-chat', name: 'Unrelated notes' };
		const html = renderChat({
			conversationKind: 'code',
			project: chatProject,
			projects: [chatProject, otherChat, codeProject],
		});
		expect(html).toContain('What should we work on?');
		expect(html).toContain('Choose project');
		expect(html).toContain('data-value=""');
		expect(html).not.toContain('<select');
		expect(html).not.toContain('Desktop source');
		expect(html).not.toContain('Unrelated notes');
		expect(html).not.toContain('Writing ideas');
		expect(html).not.toContain('Edit folders');
	});
	it('does not expose host-managed folder editing while retaining the selected project', () => {
		const html = renderChat({
			conversationKind: 'code',
			project: codeProject,
			projectReadOnly: true,
		});
		expect(html).toContain('Desktop source');
		expect(html).toContain('title="Desktop source\n/fixture/source"');
		expect(html).not.toContain('Edit folders');
		expect(html).toMatch(/<div[^>]*is-static[^>]*aria-label="Code project"/);
		expect(html).not.toMatch(/<button[^>]*aria-label="Code project"/);
		expect(html).not.toContain('aria-label="Clear project"');
	});
	it('removes redundant composer project context from a started Code task', () => {
		const html = renderChat({
			conversationKind: 'code',
			project: codeProject,
			thread: thread('started-task', 'Already started', {
				kind: 'code',
				projectId: codeProject.id,
				messages: [{ id: 'question', role: 'user', content: 'Inspect this source.', createdAt: 1 }],
			}),
		});
		expect(html).not.toContain('code-context-bar');
		expect(html).not.toContain('aria-label="Code execution host"');
		expect(html).not.toMatch(/<button[^>]*aria-label="Code project"/);
		expect(html).not.toContain('aria-label="Clear project"');
	});
	it('keeps the Code composer visible alongside pending approvals', () => {
		const html = renderChat({
			conversationKind: 'code',
			project: codeProject,
			approvalPrompt: createElement(
				'section',
				{ 'aria-label': 'Pending tool approvals' },
				'Read README.md',
			),
			draft: { content: 'Keep this draft', attachments: [], updatedAt: 1 },
		});
		expect(html).toContain('class="composer composer-approval"');
		expect(html).toContain('Read README.md');
		expect(html).toContain('class="composer"');
		expect(html).not.toContain('class="composer" hidden=""');
		expect(html).not.toContain('code-context-bar');
	});
	it('keeps an unsent Code task project selectable even when the empty task is persisted', () => {
		const html = renderChat({
			conversationKind: 'code',
			project: codeProject,
			thread: thread('empty-task', 'Unsent task', { kind: 'code', projectId: codeProject.id }),
		});
		expect(html).toMatch(/<button[^>]*aria-label="Code project"/);
		expect(html).toContain('aria-label="Clear project"');
	});
	it('shows host-managed permission values without allowing remote edits', () => {
		vi.stubGlobal('window', { desktop: { toolExecute: noop } });
		const html = renderChat({
			conversationKind: 'code',
			toolsEnabled: true,
			permissionMode: 'full-access',
			permissionReadOnly: true,
			workspaceId: 'remote',
			workspaceName: 'Workstation',
		});
		expect(html).toContain('Full access');
		expect(html).toContain('Workstation');
		expect(html).toMatch(/<button[^>]*aria-label="Code permissions"[^>]*disabled=""/);
		expect(html).toContain('Code permissions are configured on the host computer');
	});
	it('makes disabled local Code tools actionable without restoring the setup panel', () => {
		vi.stubGlobal('window', { desktop: { toolExecute: noop } });
		const html = renderChat({ conversationKind: 'code', toolsEnabled: false });
		expect(html).toContain('Code tools are disabled.');
		expect(html).toContain('Configure tools');
		expect(html).not.toContain('code-project-setup');
	});
});
