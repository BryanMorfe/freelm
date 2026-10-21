import { describe, expect, it, vi } from 'vitest';
import {
	PluginSurfaceController,
	type PluginComposerAdapter,
} from '../src/lib/plugin-surface-controller';
import { textAttachment } from '../src/lib/composer-content';
import type { Attachment } from '../src/types';
function fixture() {
	const controller = new PluginSurfaceController();
	let text = '',
		focused = true,
		working = false;
	let selection = { from: 0, to: 0, text: '' };
	let attachments: Attachment[] = [];
	const adapter: PluginComposerAdapter = {
		state: () => ({
			empty: !text.length && !attachments.length,
			editable: true,
			focused,
			working,
			running: working,
			hasAttachments: !!attachments.length,
			hasReply: false,
			hasContext: false,
			pendingAttachments: false,
			queueEditing: false,
			hasCompletedTurn: true,
		}),
		readDraft: () => ({ text, attachments: attachments.map(({ name, type }) => ({ name, type })) }),
		getSelection: () => selection,
		applyEdit: (edit) => {
			for (const change of [...edit.changes!].reverse())
				text = text.slice(0, change.from) + change.insert + text.slice(change.to);
			controller.notifyDraftChanged();
		},
		addAttachment: (attachment) => {
			attachments.push(attachment);
			controller.notifyDraftChanged();
		},
		readAttachments: () => attachments,
		removeAttachment: (index) => {
			attachments = attachments.filter((_, i) => i !== index);
			controller.notifyDraftChanged();
		},
	};
	controller.bind(adapter);
	controller.addOwner('one');
	controller.addOwner('two');
	return {
		controller,
		read: () => text,
		type: (value: string) => {
			text = value;
			controller.notifyDraftChanged();
		},
		focus: (value: boolean) => {
			focused = value;
			controller.notifyStateChanged();
		},
		working: (value: boolean) => {
			working = value;
			controller.notifyStateChanged();
		},
		selection: (from: number, to: number) => {
			selection = { from, to, text: text.slice(from, to) };
		},
	};
}
function placeholder(controller: PluginSurfaceController, owner = 'one', id = 'hint') {
	const expectedRevision = controller.getState().revision;
	controller.execute(owner, 'composer.setPlaceholder', {
		id,
		text: 'Continue this task',
		expectedRevision,
		acceptCommand: 'accept',
	});
	controller.execute(owner, 'commands.register', {
		id: 'accept',
		title: 'Accept',
		action: { type: 'composer.setText', text: 'Continue this task', expectedRevision },
	});
	controller.execute(owner, 'keybindings.register', {
		id: 'accept-key',
		key: 'Tab',
		command: 'accept',
		when: { composerFocused: true, composerEmpty: true, contributionVisible: id },
	});
}
describe('general plugin composer surface', () => {
	it('does not advertise a placeholder shortcut consumed by another plugin', () => {
		const f = fixture();
		f.controller.execute('two', 'commands.register', { id: 'other', title: 'Other' });
		f.controller.execute('two', 'keybindings.register', {
			id: 'first',
			key: 'tab',
			command: 'other',
		});
		placeholder(f.controller);
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBeUndefined();
		f.controller.execute('two', 'keybindings.remove', { id: 'first' });
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBe('Tab');
	});
	it('keeps the placeholder shortcut in sync with its own available commands and bindings', () => {
		const f = fixture();
		placeholder(f.controller);
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBe('Tab');
		f.focus(false);
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBe('Tab');
		f.controller.execute('one', 'keybindings.remove', { id: 'accept-key' });
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBeUndefined();
		placeholder(f.controller, 'two', 'other');
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBeUndefined();
		f.controller.execute('one', 'keybindings.register', {
			id: 'accept-key',
			key: 'Tab',
			command: 'accept',
			when: { placeholder: 'missing' },
		});
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBeUndefined();
		f.controller.execute('one', 'keybindings.register', {
			id: 'accept-key',
			key: 'Tab',
			command: 'accept',
			when: { placeholder: 'hint' },
		});
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBe('Tab');
		f.controller.execute('one', 'commands.remove', { id: 'accept' });
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBeUndefined();
		f.controller.execute('one', 'commands.register', { id: 'accept', title: 'Accept' });
		expect(f.controller.getSnapshot().placeholder?.acceptKey).toBe('Tab');
	});
	it('accepts a revision-bound editor action, retaining mutation origin', () => {
		const f = fixture(),
			listener = vi.fn();
		f.controller.onEvent(listener);
		placeholder(f.controller);
		expect(f.controller.handleKey('Tab')).toBe(true);
		expect(f.read()).toBe('Continue this task');
		expect(f.controller.getSnapshot().placeholder).toBeUndefined();
		expect(listener).toHaveBeenCalledWith(
			'composer.changed',
			expect.objectContaining({ origin: 'one', revision: 1 }),
		);
	});
	it('hides stale placeholders synchronously, even after typing then erasing', () => {
		const f = fixture();
		placeholder(f.controller);
		f.type('x');
		f.type('');
		expect(f.controller.handleKey('Tab')).toBe(false);
		expect(f.read()).toBe('');
		expect(() =>
			f.controller.execute('one', 'composer.setPlaceholder', {
				id: 'late',
				text: 'Stale',
				expectedRevision: 0,
			}),
		).toThrow('composer changed');
	});
	it('keeps drawer items and activation alive through ordinary draft edits', () => {
		const f = fixture();
		f.controller.execute('one', 'composer.drawer.addItem', { id: 'report', title: 'Report' });
		f.type('draft');
		expect(f.controller.getSnapshot().drawer).toHaveLength(1);
		f.controller.execute('one', 'composer.drawer.update', { id: 'report', description: 'Ready' });
		expect(f.controller.getSnapshot().drawer[0].description).toBe('Ready');
	});
	it('reports a dismissed contribution with its owner for scoped event delivery', () => {
		const f = fixture(),
			listener = vi.fn();
		f.controller.onEvent(listener);
		f.controller.execute('one', 'composer.drawer.addItem', {
			id: 'report',
			title: 'Report',
			dismissible: true,
		});
		f.controller.dismissDrawer('one', 'report');
		expect(f.controller.getSnapshot().drawer).toHaveLength(0);
		expect(listener).toHaveBeenCalledWith('contribution.dismissed', { owner: 'one', id: 'report' });
	});
	it('removing a hidden placeholder never clears another owner presentation', () => {
		const f = fixture();
		placeholder(f.controller);
		placeholder(f.controller, 'two', 'other');
		f.controller.execute('two', 'composer.placeholder.remove', { id: 'other' });
		expect(f.controller.getSnapshot().placeholder?.owner).toBe('one');
		f.controller.removeOwner('one');
		expect(f.controller.getSnapshot().placeholder).toBeUndefined();
		expect(() => f.controller.execute('one', 'composer.readDraft')).toThrow('no longer available');
	});
	it('supports rewriting an arbitrary selected range and rejects stale changes', () => {
		const f = fixture();
		f.type('some old words');
		f.selection(5, 8);
		f.controller.execute('one', 'composer.insertText', { text: 'new', expectedRevision: 1 });
		expect(f.read()).toBe('some new words');
		expect(() =>
			f.controller.execute('one', 'composer.setText', { text: 'stale', expectedRevision: 1 }),
		).toThrow();
	});
	it('arbitrates keys by focus, empty state, owned visibility, and command validity', () => {
		const f = fixture();
		placeholder(f.controller);
		f.focus(false);
		expect(f.controller.handleKey('Tab')).toBe(false);
		f.focus(true);
		f.controller.execute('one', 'commands.remove', { id: 'accept' });
		expect(f.controller.handleKey('Tab')).toBe(false);
		f.controller.execute('two', 'keybindings.register', {
			id: 'bad',
			key: 'Tab',
			command: 'none',
			when: { contributionVisible: 'hint' },
		});
		expect(f.controller.handleKey('Tab')).toBe(false);
	});
	it('does not hardcode successful-answer or working policy into drawer or placeholder APIs', () => {
		const f = fixture();
		f.working(true);
		placeholder(f.controller);
		expect(f.controller.getSnapshot().placeholder?.text).toBeTruthy();
	});
	it('dispatches async commands with no raw input text or keystrokes', () => {
		const f = fixture(),
			callback = vi.fn();
		f.controller.onCommand(callback);
		f.controller.execute('one', 'commands.register', { id: 'report', title: 'Build report' });
		expect(f.controller.invokeCommand('one', 'report')).toBe(true);
		expect(callback).toHaveBeenCalledWith('one', 'report', { composerRevision: 0 });
	});
	it('promotes assets into user draft attachments that survive owner disposal', () => {
		const f = fixture(),
			attachment = textAttachment('Report contents', 'report.txt');
		f.controller.execute('one', 'composer.attachments.add', {
			asset: { name: attachment.name, mimeType: attachment.type, dataUrl: attachment.dataUrl },
			expectedRevision: 0,
		});
		const draft = f.controller.execute('one', 'composer.readDraft') as {
			attachments: { id: string; name: string }[];
		};
		f.controller.removeOwner('one');
		expect(
			f.controller.execute('two', 'composer.attachments.read', { id: draft.attachments[0].id }),
		).toEqual({ name: 'report.txt', mimeType: 'text/plain', text: 'Report contents' });
		f.controller.execute('two', 'composer.attachments.remove', {
			id: draft.attachments[0].id,
			expectedRevision: 1,
		});
		expect(f.controller.getState().empty).toBe(true);
	});
	it('checks ranges and does not apply malformed or overlapping edits', () => {
		const f = fixture();
		f.type('example');
		for (const changes of [
			[{ from: -1, to: 0, insert: 'x' }],
			[{ from: 0, to: 99, insert: 'x' }],
			[
				{ from: 0, to: 4, insert: 'a' },
				{ from: 2, to: 3, insert: 'b' },
			],
		])
			expect(() =>
				f.controller.execute('one', 'composer.applyEdit', { expectedRevision: 1, changes }),
			).toThrow();
		expect(f.read()).toBe('example');
	});
	it('permits only packaged custom views and bounds their height', () => {
		const f = fixture();
		expect(() =>
			f.controller.execute('one', 'composer.drawer.addView', {
				id: 'view',
				url: 'https://untrusted.test',
				nonce: 'nonce',
			}),
		).toThrow();
		f.controller.execute('one', 'composer.drawer.addView', {
			id: 'view',
			url: 'freelm-plugin://view/test',
			nonce: 'nonce',
			height: 10000,
		});
		expect(f.controller.getSnapshot().drawer[0].view?.height).toBe(300);
	});
});
