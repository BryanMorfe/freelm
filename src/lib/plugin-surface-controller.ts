import type { Attachment } from '../types';

export interface PluginComposerState {
	revision: number;
	empty: boolean;
	editable: boolean;
	focused: boolean;
	working: boolean;
	running: boolean;
	hasAttachments: boolean;
	hasReply: boolean;
	hasContext: boolean;
	pendingAttachments: boolean;
	queueEditing: boolean;
	hasCompletedTurn: boolean;
	hasQueuedMessages?: boolean;
	awaitingInput?: boolean;
}
export interface PluginEditorEdit {
	expectedRevision: number;
	changes?: { from: number; to: number; insert: string }[];
	text?: string;
	replace?: { from: number; to: number; text: string };
	selection?: { anchor: number; head?: number };
}
export interface PluginComposerAdapter {
	state(): Omit<PluginComposerState, 'revision'>;
	readDraft(): { text: string; attachments: { name: string; type: string }[] };
	getSelection(): { from: number; to: number; text: string };
	applyEdit(edit: PluginEditorEdit): void;
	addAttachment(attachment: Attachment): void;
	readAttachments(): Attachment[];
	removeAttachment(index: number): void;
}
interface Owned {
	owner: string;
	id: string;
}
export interface PluginPlaceholder extends Owned {
	text: string;
	expectedRevision: number;
	acceptCommand?: string;
	hint?: string;
}
export interface PluginDrawerItem extends Owned {
	title: string;
	description?: string;
	icon?: string;
	progress?: number;
	dismissible?: boolean;
	actions?: { title: string; command: string }[];
	view?: { url: string; nonce: string; props?: Record<string, unknown>; height: number };
}
interface Command extends Owned {
	title: string;
	action?: Record<string, unknown>;
}
interface Keybinding extends Owned {
	key: string;
	command: string;
	when: Record<string, unknown>;
}
export interface PluginSurfacePresentation {
	placeholder?: PluginPlaceholder & { acceptKey?: string };
	drawer: PluginDrawerItem[];
}
type EventListener = (name: string, payload: Record<string, unknown>) => void;
const initialPresentation: PluginSurfacePresentation = { drawer: [] };
const maxContributions = 48;
const textLimit = 200_000;
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Expected an object.');
	return value as Record<string, unknown>;
}
function string(value: unknown, name: string, limit = 512): string {
	if (typeof value !== 'string' || !value || value.length > limit)
		throw new Error(`Invalid ${name}.`);
	return value;
}
function key(owner: string, id: string) {
	return `${owner}\0${id}`;
}

/** Renderer-owned surface operations. No plugin receives the native editor or app state. */
export class PluginSurfaceController {
	private adapter?: PluginComposerAdapter;
	private revision = 0;
	private owners = new Set<string>();
	private placeholders = new Map<string, PluginPlaceholder>();
	private drawer = new Map<string, PluginDrawerItem>();
	private commands = new Map<string, Command>();
	private bindings = new Map<string, Keybinding>();
	private listeners = new Set<() => void>();
	private events = new Set<EventListener>();
	private commandListeners = new Set<
		(owner: string, id: string, payload: Record<string, unknown>) => void
	>();
	private presentation: PluginSurfacePresentation = initialPresentation;
	private mutationOrigin = 'user';
	private attachmentIds = new WeakMap<Attachment, string>();
	private attachmentSequence = 0;
	private viewCaller?: (
		owner: string,
		method: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
	private lastState = '';
	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	readonly getSnapshot = () => this.presentation;
	onEvent(listener: EventListener) {
		this.events.add(listener);
		return () => {
			this.events.delete(listener);
		};
	}
	onCommand(listener: (owner: string, id: string, payload: Record<string, unknown>) => void) {
		this.commandListeners.add(listener);
		return () => {
			this.commandListeners.delete(listener);
		};
	}
	setViewCaller(
		caller: (owner: string, method: string, args: Record<string, unknown>) => Promise<unknown>,
	) {
		this.viewCaller = caller;
	}
	callView(owner: string, method: string, args: Record<string, unknown>) {
		if (!this.owners.has(owner) || !this.viewCaller)
			return Promise.reject(new Error('This view is no longer available.'));
		return this.viewCaller(owner, method, args);
	}
	addOwner(owner: string) {
		this.owners.add(owner);
	}
	removeOwner(owner: string) {
		this.owners.delete(owner);
		for (const collection of [this.placeholders, this.drawer, this.commands, this.bindings])
			for (const [id, value] of collection) if (value.owner === owner) collection.delete(id);
		this.publish();
	}
	bind(adapter: PluginComposerAdapter) {
		this.adapter = adapter;
		this.notifyStateChanged();
		return () => {
			if (this.adapter === adapter) {
				this.adapter = undefined;
				this.revision++;
				this.publish();
			}
		};
	}
	getState(): PluginComposerState {
		const state = this.adapter?.state();
		return {
			revision: this.revision,
			empty: true,
			editable: false,
			focused: false,
			working: false,
			running: false,
			hasAttachments: false,
			hasReply: false,
			hasContext: false,
			pendingAttachments: false,
			queueEditing: false,
			hasCompletedTurn: false,
			...state,
		};
	}
	notifyDraftChanged(origin = this.mutationOrigin) {
		this.revision++;
		this.publish();
		this.emit('composer.changed', { ...this.getState(), origin });
	}
	notifySelectionChanged() {
		this.emit('composer.selectionChanged', {
			revision: this.revision,
			origin: this.mutationOrigin,
		});
	}
	notifyStateChanged() {
		const state = this.getState();
		const encoded = JSON.stringify(state);
		if (encoded === this.lastState) return;
		this.lastState = encoded;
		this.publish();
		this.emit('composer.stateChanged', { ...state });
	}
	private emit(name: string, payload: Record<string, unknown>) {
		for (const listener of this.events) listener(name, payload);
	}
	private publish() {
		const state = this.getState();
		const placeholder =
			state.empty && state.editable
				? [...this.placeholders.values()].find((item) => item.expectedRevision === this.revision)
				: undefined;
		const claimedKeys = new Set<string>();
		const acceptKey = placeholder?.acceptCommand
			? [...this.bindings.values()].find((binding) => {
					if (
						!this.commands.has(key(binding.owner, binding.command)) ||
						!this.bindingApplies(binding, { ...state, focused: true }, placeholder)
					)
						return false;
					const normalizedKey = binding.key.toLowerCase();
					if (claimedKeys.has(normalizedKey)) return false;
					claimedKeys.add(normalizedKey);
					return (
						binding.owner === placeholder.owner && binding.command === placeholder.acceptCommand
					);
				})?.key
			: undefined;
		this.presentation = {
			placeholder: placeholder ? { ...placeholder, acceptKey } : undefined,
			drawer: [...this.drawer.values()],
		};
		for (const listener of this.listeners) listener();
	}
	private expected(value: unknown) {
		if (!Number.isSafeInteger(value) || value !== this.revision)
			throw new Error('The composer changed. Read its current revision and try again.');
	}
	private native() {
		if (!this.adapter) throw new Error('This composer is no longer available.');
		return this.adapter;
	}
	private checkCapacity(map: Map<string, Owned>, owner: string, id: string) {
		if (
			!map.has(key(owner, id)) &&
			[...map.values()].filter((item) => item.owner === owner).length >= maxContributions
		)
			throw new Error('Too many plugin contributions.');
	}
	private edit(owner: string, args: Record<string, unknown>) {
		this.expected(args.expectedRevision);
		if (!this.getState().editable) throw new Error('The composer is not editable.');
		const native = this.native();
		const length = native.readDraft().text.length;
		let changes: PluginEditorEdit['changes'];
		if (typeof args.text === 'string') changes = [{ from: 0, to: length, insert: args.text }];
		else if (args.replace) {
			const replacement = record(args.replace);
			changes = [
				{
					from: Number(replacement.from),
					to: Number(replacement.to),
					insert: replacement.text as string,
				},
			];
		} else if (Array.isArray(args.changes))
			changes = args.changes.map((change) => {
				const c = record(change);
				return { from: Number(c.from), to: Number(c.to), insert: c.insert as string };
			});
		if (!changes?.length || changes.length > 64)
			throw new Error('Provide a bounded set of editor changes.');
		let end = 0,
			resultLength = length;
		for (const change of changes) {
			if (
				!Number.isInteger(change.from) ||
				!Number.isInteger(change.to) ||
				change.from < end ||
				change.to < change.from ||
				change.to > length ||
				typeof change.insert !== 'string'
			)
				throw new Error('Invalid editor range.');
			end = change.to;
			resultLength += change.insert.length - (change.to - change.from);
		}
		if (resultLength > textLimit) throw new Error('The resulting draft is too large.');
		const selection = args.selection as PluginEditorEdit['selection'];
		if (
			selection &&
			[selection.anchor, selection.head ?? selection.anchor].some(
				(position) => !Number.isInteger(position) || position < 0 || position > resultLength,
			)
		)
			throw new Error('Invalid editor selection.');
		this.mutationOrigin = owner;
		try {
			native.applyEdit({ expectedRevision: this.revision, changes, selection });
		} finally {
			this.mutationOrigin = 'user';
		}
		return this.getState();
	}
	execute(owner: string, method: string, raw: unknown = {}): unknown {
		if (!this.owners.has(owner)) throw new Error('This plugin activation is no longer available.');
		const args = record(raw);
		if (method === 'composer.getState') return this.getState();
		if (method === 'composer.readDraft') {
			const selection = this.native().getSelection();
			const attachments = this.native()
				.readAttachments()
				.map((attachment) => {
					let id = this.attachmentIds.get(attachment);
					if (!id) {
						id = `attachment-${++this.attachmentSequence}`;
						this.attachmentIds.set(attachment, id);
					}
					return {
						id,
						name: attachment.name,
						mimeType: attachment.type,
						size: this.attachmentSize(attachment),
					};
				});
			return {
				...this.getState(),
				text: this.native().readDraft().text,
				selection: { anchor: selection.from, head: selection.to, text: selection.text },
				attachments,
			};
		}
		if (method === 'composer.getSelection') {
			const selection = this.native().getSelection();
			return { anchor: selection.from, head: selection.to, text: selection.text };
		}
		if (method === 'composer.applyEdit' || method === 'composer.setText')
			return this.edit(owner, args);
		if (method === 'composer.insertText') {
			const selected = this.native().getSelection();
			return this.edit(owner, {
				...args,
				text: undefined,
				changes: [{ from: selected.from, to: selected.to, insert: args.text }],
			});
		}
		if (method === 'composer.attachments.add') {
			this.expected(args.expectedRevision);
			if (!this.getState().editable) throw new Error('The composer is not editable.');
			this.mutationOrigin = owner;
			try {
				const asset = args.asset as { name: string; mimeType: string; dataUrl: string } | undefined;
				this.native().addAttachment(
					asset
						? { name: asset.name, type: asset.mimeType, dataUrl: asset.dataUrl }
						: (args.attachment as Attachment),
				);
			} finally {
				this.mutationOrigin = 'user';
			}
			return this.getState();
		}
		if (method === 'composer.attachments.read' || method === 'composer.attachments.remove') {
			const attachments = this.native().readAttachments();
			const index = attachments.findIndex(
				(attachment) => this.attachmentIds.get(attachment) === args.id,
			);
			if (index < 0) throw new Error('This attachment is no longer in the draft.');
			if (method.endsWith('.remove')) {
				this.expected(args.expectedRevision);
				if (!this.getState().editable) throw new Error('The composer is not editable.');
				this.mutationOrigin = owner;
				try {
					this.native().removeAttachment(index);
				} finally {
					this.mutationOrigin = 'user';
				}
				return this.getState();
			}
			const attachment = attachments[index],
				bytes = this.attachmentBytes(attachment);
			return attachment.type === 'text/plain'
				? {
						name: attachment.name,
						mimeType: attachment.type,
						text: new TextDecoder().decode(bytes),
					}
				: {
						name: attachment.name,
						mimeType: attachment.type,
						base64: attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1),
					};
		}
		const id = string(args.id, 'contribution ID', 160),
			ownKey = key(owner, id);
		if (method === 'composer.setPlaceholder' || method === 'composer.placeholder.update') {
			const prior = this.placeholders.get(ownKey);
			if (method.endsWith('.update') && !prior) throw new Error('Placeholder no longer exists.');
			const value = { ...prior, ...args };
			const expectedRevision = value.expectedRevision ?? this.revision;
			this.expected(expectedRevision);
			this.checkCapacity(this.placeholders, owner, id);
			this.placeholders.set(ownKey, {
				owner,
				id,
				text: string(value.text, 'placeholder', 2000),
				expectedRevision: expectedRevision as number,
				acceptCommand:
					value.acceptCommand === undefined
						? undefined
						: string(value.acceptCommand, 'command', 160),
				hint: value.hint === undefined ? undefined : string(value.hint, 'hint', 80),
			});
			this.publish();
			return { id };
		}
		if (method === 'composer.placeholder.remove') {
			this.placeholders.delete(ownKey);
			this.publish();
			return null;
		}
		if (method === 'composer.drawer.addView') {
			// Only the host may resolve a declared bundled view to this URL. This
			// operation crosses the authorized bridge, never an iframe DOM escape.
			const url = string(args.url, 'view URL', 4000),
				nonce = string(args.nonce, 'view nonce', 160);
			if (!url.startsWith('freelm-plugin://'))
				throw new Error('Views must use a packaged plugin document.');
			this.checkCapacity(this.drawer, owner, id);
			this.drawer.set(ownKey, {
				owner,
				id,
				title: typeof args.title === 'string' ? args.title.slice(0, 300) : 'Plugin view',
				view: {
					url,
					nonce,
					props: args.props as Record<string, unknown> | undefined,
					height: Math.max(80, Math.min(300, Number(args.height) || 180)),
				},
			});
			this.publish();
			return { id };
		}
		if (method === 'composer.drawer.addItem' || method === 'composer.drawer.update') {
			const prior = this.drawer.get(ownKey);
			if (method.endsWith('.update') && !prior) throw new Error('Drawer item no longer exists.');
			const value = { ...prior, ...args };
			if (prior?.view) {
				this.drawer.set(ownKey, {
					...prior,
					title: typeof args.title === 'string' ? args.title.slice(0, 300) : prior.title,
					view: {
						...prior.view,
						props: (args.props as Record<string, unknown> | undefined) ?? prior.view.props,
						height:
							args.height === undefined
								? prior.view.height
								: Math.max(80, Math.min(300, Number(args.height) || 180)),
					},
				});
				this.publish();
				return { id };
			}
			const actions =
				value.actions === undefined
					? undefined
					: (Array.isArray(value.actions) ? value.actions : []).map((raw) => {
							const action = record(raw);
							return {
								title: string(action.title, 'action title', 160),
								command: string(action.command, 'command', 160),
							};
						});
			if ((actions?.length ?? 0) > 5) throw new Error('A drawer item supports up to five actions.');
			this.checkCapacity(this.drawer, owner, id);
			this.drawer.set(ownKey, {
				owner,
				id,
				title: string(value.title, 'drawer title', 300),
				description:
					value.description === undefined
						? undefined
						: string(value.description, 'description', 2000),
				icon: typeof value.icon === 'string' ? value.icon : undefined,
				dismissible: value.dismissible === true,
				actions,
				progress:
					typeof value.progress === 'number' && Number.isFinite(value.progress)
						? Math.max(0, Math.min(1, value.progress))
						: undefined,
			});
			this.publish();
			return { id };
		}
		if (method === 'composer.drawer.remove') {
			this.drawer.delete(ownKey);
			this.publish();
			return null;
		}
		if (method === 'commands.run') return this.invokeCommand(owner, id);
		if (method === 'commands.register') {
			this.checkCapacity(this.commands, owner, id);
			this.commands.set(ownKey, {
				owner,
				id,
				title: string(args.title, 'command title', 160),
				action: (args.action ?? args.hostAction) as Record<string, unknown> | undefined,
			});
			this.publish();
			return { id };
		}
		if (method === 'commands.remove') {
			this.commands.delete(ownKey);
			this.publish();
			return null;
		}
		if (method === 'keybindings.register') {
			this.checkCapacity(this.bindings, owner, id);
			const keyName = string(args.key, 'key', 50);
			if (!/^(Tab|Escape|(?:Mod-|Alt-)(?:Shift-)?[a-z])$/i.test(keyName))
				throw new Error('Use Tab, Escape, or a modified letter for contextual shortcuts.');
			const when = args.when === undefined ? {} : record(args.when);
			const valid = [
				'composerFocused',
				'composerEmpty',
				'contributionVisible',
				'hasSelection',
				'focused',
				'empty',
				'editable',
				'placeholder',
			];
			if (
				Object.entries(when).some(
					([key, value]) =>
						!valid.includes(key) ||
						(['contributionVisible', 'placeholder'].includes(key)
							? typeof value !== 'string'
							: typeof value !== 'boolean'),
				)
			)
				throw new Error('Invalid keybinding conditions.');
			this.bindings.set(ownKey, {
				owner,
				id,
				key: keyName,
				command: string(args.command, 'command', 160),
				when,
			});
			this.publish();
			return { id };
		}
		if (method === 'keybindings.remove') {
			this.bindings.delete(ownKey);
			this.publish();
			return null;
		}
		throw new Error(`Unsupported surface operation: ${method}`);
	}
	private attachmentSize(attachment: Attachment): number {
		const encoded = attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1);
		return (encoded.length * 3) / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
	}
	private attachmentBytes(attachment: Attachment): Uint8Array {
		const comma = attachment.dataUrl.indexOf(',');
		if (comma < 0) throw new Error('Invalid attachment data.');
		return Uint8Array.from(atob(attachment.dataUrl.slice(comma + 1)), (character) =>
			character.charCodeAt(0),
		);
	}
	invokeCommand(owner: string, id: string): boolean {
		const command = this.commands.get(key(owner, id));
		if (!this.owners.has(owner) || !command || !this.getState().editable) return false;
		if (command.action) {
			try {
				this.execute(owner, String(command.action.type), command.action);
				return true;
			} catch {
				return false;
			}
		}
		for (const listener of this.commandListeners)
			listener(owner, id, { composerRevision: this.revision });
		return this.commandListeners.size > 0;
	}
	handleKey(keyName: string): boolean {
		const state = this.getState();
		if (!state.editable || !state.focused) return false;
		for (const binding of this.bindings.values()) {
			if (binding.key.toLowerCase() !== keyName.toLowerCase()) continue;
			if (!this.bindingApplies(binding, state, this.presentation.placeholder)) continue;
			if (this.invokeCommand(binding.owner, binding.command)) return true;
		}
		return false;
	}
	private bindingApplies(
		binding: Keybinding,
		state: PluginComposerState,
		placeholder?: PluginPlaceholder,
	): boolean {
		const when = binding.when;
		const focused = when.composerFocused ?? when.focused;
		const empty = when.composerEmpty ?? when.empty;
		if (focused !== undefined && focused !== state.focused) return false;
		if (empty !== undefined && empty !== state.empty) return false;
		if (when.editable !== undefined && when.editable !== state.editable) return false;
		if (when.hasSelection !== undefined) {
			const selection = this.native().getSelection();
			if (when.hasSelection !== (selection.from !== selection.to)) return false;
		}
		const visibleId = when.contributionVisible ?? when.placeholder;
		return (
			!visibleId ||
			(placeholder?.owner === binding.owner && placeholder.id === visibleId) ||
			[...this.drawer.values()].some(
				(item) => item.owner === binding.owner && item.id === visibleId,
			)
		);
	}
	dismissDrawer(owner: string, id: string) {
		if (!this.drawer.get(key(owner, id))?.dismissible) return;
		this.drawer.delete(key(owner, id));
		this.publish();
		this.emit('contribution.dismissed', { owner, id });
	}
}
