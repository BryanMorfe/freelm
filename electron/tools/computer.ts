import { randomUUID } from 'node:crypto';
import type { ToolHostRequest, ToolResult } from '../../src/agent-types';
import type {
	ComputerAction,
	ComputerApp,
	ComputerObservation,
	ComputerSessionPreview,
	ComputerStatus,
} from '../../src/computer-types';

/** Native adapters must verify app/window identity, frame freshness and focus before actions. */
export interface ComputerAdapter {
	status(signal?: AbortSignal): Promise<ComputerStatus>;
	apps(query: string, signal: AbortSignal): Promise<ComputerApp[]>;
	open(appId: string, signal: AbortSignal): Promise<void>;
	snapshot(appId: string, signal: AbortSignal): Promise<ComputerObservation>;
	act(appId: string, frameId: string, action: ComputerAction, signal: AbortSignal): Promise<void>;
	close(): void | Promise<void>;
}
export interface ComputerRuntimeOptions {
	adapter: ComputerAdapter;
	onPreview?: (preview: ComputerSessionPreview) => void;
}
interface ComputerContext {
	signal: AbortSignal;
	/** Reload live host authority immediately before every native operation. */
	check: () => Promise<string>;
	authorize: (
		app: ComputerApp,
		signal: AbortSignal,
	) => Promise<{
		approved: boolean;
		reason: string;
		scopeFingerprint: string;
	}>;
	ensurePermissions: (
		app: ComputerApp,
		signal: AbortSignal,
	) => Promise<{ approved: boolean; reason: string; prompted: boolean }>;
}
class ComputerSetupDeclined extends Error {}
interface Session {
	id: string;
	runId: string;
	threadId: string;
	app: ComputerApp;
	scope: string;
	controller: AbortController;
	observation?: ComputerObservation;
}
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_SESSIONS = 8;
const MAX_MODEL_TEXT_CHARS = 60_000;
const MAX_ELEMENT_CHARS = 45_000;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
function exact(
	value: unknown,
	required: string[],
	optional: string[] = [],
): asserts value is Record<string, unknown> {
	if (
		!record(value) ||
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
	)
		throw new Error('Invalid Computer Use arguments.');
}
function text(value: unknown, max: number, empty = false): value is string {
	return (
		typeof value === 'string' &&
		value.length <= max &&
		(empty || !!value.trim()) &&
		!value.includes('\0')
	);
}
function id(value: unknown): asserts value is string {
	if (!text(value, 512) || /[\x00-\x1f\x7f]/.test(value))
		throw new Error('Invalid Computer Use identity.');
}
function appIdentity(app: unknown): ComputerApp {
	if (!record(app)) throw new Error('The application registry returned an invalid app.');
	id(app.id);
	// Names are presentation metadata, not the permission principal. Some installed
	// bundles supply an empty display name; never let that break another app's lookup.
	const name =
		typeof app.name === 'string'
			? app.name
					.replace(/[\x00-\x1f\x7f]/g, ' ')
					.trim()
					.slice(0, 256)
			: '';
	return {
		id: app.id,
		name: name || app.id.slice(0, 256),
		...(typeof app.icon === 'string' &&
		app.icon.length < 256_000 &&
		/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(app.icon)
			? { icon: app.icon }
			: {}),
	};
}
function validBounds(value: unknown): boolean {
	return (
		record(value) &&
		['x', 'y', 'width', 'height'].every(
			(key) =>
				typeof value[key] === 'number' &&
				Number.isFinite(value[key]) &&
				Math.abs(value[key] as number) <= 1_000_000,
		) &&
		(value.width as number) > 0 &&
		(value.height as number) > 0
	);
}
function observation(value: ComputerObservation, app: ComputerApp): ComputerObservation {
	// The verified session identity supplies the display name/icon. A snapshot
	// cannot change that identity, and need not repeat optional display metadata.
	if (!record(value) || !record(value.app) || value.app.id !== app.id)
		throw new Error('The observed app does not match the approved app.');
	id(value.frameId);
	if (
		!record(value.window) ||
		!text(value.window.id, 512) ||
		!text(value.window.title, 4096, true) ||
		!validBounds(value.window.bounds) ||
		!record(value.image) ||
		!Number.isInteger(value.image.width) ||
		!Number.isInteger(value.image.height) ||
		(value.image.width as number) < 1 ||
		(value.image.height as number) < 1 ||
		(value.image.width as number) > 32768 ||
		(value.image.height as number) > 32768 ||
		!text(value.image.dataUrl, MAX_FRAME_CHARS) ||
		!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.image.dataUrl) ||
		!Array.isArray(value.elements) ||
		value.elements.length > 1000
	)
		throw new Error('The native app observation is invalid or exceeds the image limit.');
	const ids = new Set<string>();
	for (const item of value.elements) {
		if (
			!record(item) ||
			!text(item.id, 512) ||
			ids.has(item.id) ||
			!text(item.role, 256) ||
			(item.label !== undefined && !text(item.label, 4096, true)) ||
			(item.value !== undefined && !text(item.value, 16000, true)) ||
			(item.bounds !== undefined && !validBounds(item.bounds)) ||
			(item.actions !== undefined &&
				(!Array.isArray(item.actions) ||
					item.actions.length > 32 ||
					!item.actions.every((a) => text(a, 128))))
		)
			throw new Error('The native accessibility observation is invalid.');
		ids.add(item.id);
	}
	if (
		value.notices !== undefined &&
		(!Array.isArray(value.notices) ||
			value.notices.length > 32 ||
			!value.notices.every((notice) => text(notice, 4096)))
	)
		throw new Error('The native app notices are invalid.');
	return structuredClone({ ...value, app });
}
function action(value: unknown, frame: ComputerObservation): ComputerAction {
	if (!record(value)) throw new Error('Invalid computer action.');
	const type = value.type;
	if (type === 'click' || type === 'double_click' || type === 'scroll' || type === 'drag') {
		exact(
			value,
			type === 'scroll'
				? ['type', 'x', 'y', 'deltaX', 'deltaY']
				: type === 'drag'
					? ['type', 'x', 'y', 'toX', 'toY']
					: ['type', 'x', 'y'],
		);
		if (
			!Number.isInteger(value.x) ||
			!Number.isInteger(value.y) ||
			(value.x as number) < 0 ||
			(value.x as number) >= frame.image.width ||
			(value.y as number) < 0 ||
			(value.y as number) >= frame.image.height
		)
			throw new Error('Action coordinates must be inside the latest screenshot.');
		if (
			type === 'drag' &&
			(!Number.isInteger(value.toX) ||
				!Number.isInteger(value.toY) ||
				(value.toX as number) < 0 ||
				(value.toX as number) >= frame.image.width ||
				(value.toY as number) < 0 ||
				(value.toY as number) >= frame.image.height)
		)
			throw new Error('The drag destination must be inside the latest screenshot.');
		if (
			type === 'scroll' &&
			['deltaX', 'deltaY'].some(
				(key) => !Number.isInteger(value[key]) || Math.abs(value[key] as number) > 10000,
			)
		)
			throw new Error('Scroll deltas must be integers between -10000 and 10000.');
	} else if (type === 'type' || type === 'set_value') {
		exact(value, type === 'type' ? ['type', 'text'] : ['type', 'elementId', 'text']);
		if (!text(value.text, 16000, true)) throw new Error('Computer input exceeds the text limit.');
	} else if (type === 'press' || type === 'select') exact(value, ['type', 'elementId']);
	else if (type === 'key') {
		exact(value, ['type', 'key'], ['modifiers']);
		if (
			typeof value.key !== 'string' ||
			!/^(?:[a-zA-Z0-9]|Enter|Return|Tab|Escape|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F[1-9]|F1[0-2])$/.test(
				value.key,
			)
		)
			throw new Error('Unsupported Computer Use key.');
		if (
			value.modifiers !== undefined &&
			(!Array.isArray(value.modifiers) ||
				value.modifiers.length > 4 ||
				new Set(value.modifiers).size !== value.modifiers.length ||
				!value.modifiers.every((key) => ['cmd', 'ctrl', 'alt', 'shift'].includes(String(key))))
		)
			throw new Error('Invalid Computer Use key modifiers.');
	} else throw new Error('Unsupported computer action.');
	if (type === 'press' || type === 'select' || type === 'set_value') {
		id(value.elementId);
		const element = frame.elements.find((item) => item.id === value.elementId);
		if (!element) throw new Error('The element is not present in the latest observation.');
		if (type === 'select' && !element.actions?.includes('select'))
			throw new Error('The element does not advertise select in the latest observation.');
	}
	return structuredClone(value) as unknown as ComputerAction;
}

/** One native action at a time across every task; grants and previews are host-owned. */
export class ComputerRuntime {
	private sessions = new Map<string, Session>();
	private previews = new Map<string, ComputerSessionPreview>();
	private queue: Promise<unknown> = Promise.resolve();
	private lifetime = new AbortController();
	constructor(private options: ComputerRuntimeOptions) {}
	status(signal?: AbortSignal) {
		return this.options.adapter.status(signal);
	}
	async apps(query: string, signal: AbortSignal): Promise<ComputerApp[]> {
		if (!text(query, 256, true)) throw new Error('The app query exceeds the limit.');
		signal.throwIfAborted();
		const apps = await this.options.adapter.apps(query, signal);
		signal.throwIfAborted();
		if (!Array.isArray(apps) || apps.length > 2048)
			throw new Error('The application registry exceeds the limit.');
		const verified = new Map<string, ComputerApp>();
		for (const app of apps) {
			try {
				const safe = appIdentity(app);
				if (!verified.has(safe.id)) verified.set(safe.id, safe);
			} catch {
				// A malformed unrelated registry entry cannot block valid applications.
				// Invalid identities are omitted, never converted into a permission grant.
			}
		}
		return [...verified.values()];
	}
	currentSessions(): ComputerSessionPreview[] {
		return structuredClone([...this.previews.values()]);
	}
	private publish(session: Session, status: ComputerSessionPreview['status']) {
		const frame = session.observation;
		const previous = this.previews.get(session.id);
		const preview: ComputerSessionPreview = {
			sessionId: session.id,
			runId: session.runId,
			threadId: session.threadId,
			app: session.app,
			status,
			updatedAt: Date.now(),
			...(frame
				? { image: frame.image, windowTitle: frame.window.title }
				: previous
					? { image: previous.image, windowTitle: previous.windowTitle }
					: {}),
		};
		this.previews.delete(session.id);
		this.previews.set(session.id, preview);
		while (this.previews.size > MAX_SESSIONS)
			this.previews.delete(this.previews.keys().next().value!);
		try {
			this.options.onPreview?.(structuredClone(preview));
		} catch {
			/* UI cannot grant or revoke host authority. */
		}
	}
	stopSession(sessionId: string): string | undefined {
		id(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.controller.abort();
		this.sessions.delete(sessionId);
		this.publish(session, 'stopped');
		return session.runId;
	}
	stopRun(runId: string): void {
		for (const session of this.sessions.values())
			if (session.runId === runId) this.stopSession(session.id);
	}
	private async check(context: ComputerContext, signal: AbortSignal, session?: Session) {
		signal.throwIfAborted();
		const scope = await context.check();
		signal.throwIfAborted();
		if (session && (this.sessions.get(session.id) !== session || session.scope !== scope)) {
			this.stopSession(session.id);
			throw new Error('Computer Use permission changed. Open the app again to request access.');
		}
		return scope;
	}
	private async observe(
		session: Session,
		context: ComputerContext,
		signal: AbortSignal,
		actionNotice?: string,
		restoreFocus = false,
	): Promise<ToolResult> {
		if ((await this.ensurePermissions(session, context, signal)) || restoreFocus)
			await this.options.adapter.open(session.app.id, signal);
		const frame = observation(
			await this.options.adapter.snapshot(session.app.id, signal),
			session.app,
		);
		await this.check(context, signal, session);
		// Bound complete JSON before the generic tool limiter can cut it mid-object.
		const notices = (frame.notices ?? []).slice(0, 8).map((notice) => notice.slice(0, 512));
		if (actionNotice) notices.push(actionNotice);
		if ((frame.notices?.length ?? 0) > 8 || frame.notices?.some((notice) => notice.length > 512))
			notices.push('Some native app notices were shortened.');
		const modelFrame = {
			sessionId: session.id,
			app: { id: session.app.id, name: session.app.name },
			frameId: frame.frameId,
			window: {
				id: frame.window.id,
				title: frame.window.title,
				bounds: {
					x: frame.window.bounds.x,
					y: frame.window.bounds.y,
					width: frame.window.bounds.width,
					height: frame.window.bounds.height,
				},
			},
			imageSize: { width: frame.image.width, height: frame.image.height },
			elements: [] as ComputerObservation['elements'],
			notices,
		};
		const elementBudget = Math.min(
			MAX_ELEMENT_CHARS,
			MAX_MODEL_TEXT_CHARS - JSON.stringify(modelFrame).length - 512,
		);
		let elementChars = 0;
		for (const item of frame.elements) {
			const element = {
				id: item.id,
				role: item.role,
				label: item.label,
				value: item.value,
				bounds: item.bounds
					? {
							x: item.bounds.x,
							y: item.bounds.y,
							width: item.bounds.width,
							height: item.bounds.height,
						}
					: undefined,
				actions: item.actions,
			};
			const chars = JSON.stringify(element).length + 1;
			if (elementChars + chars > elementBudget) break;
			modelFrame.elements.push(element);
			elementChars += chars;
		}
		if (modelFrame.elements.length < frame.elements.length)
			notices.push(
				`Accessibility tree truncated: ${modelFrame.elements.length} of ${frame.elements.length} elements returned. Only returned element IDs can be acted on; use the screenshot for other visible controls.`,
			);
		// Never accept a guessed ID omitted from the model's bounded observation.
		session.observation = { ...frame, elements: modelFrame.elements };
		this.publish(session, 'active');
		return {
			computer: { sessionId: session.id, app: session.app },
			content: [
				{
					type: 'text',
					text: JSON.stringify(modelFrame),
				},
				{
					type: 'image',
					purpose: 'computer',
					name: `${session.app.name} screen`,
					dataUrl: frame.image.dataUrl,
				},
			],
		};
	}
	private async ensurePermissions(
		session: Session,
		context: ComputerContext,
		signal: AbortSignal,
	): Promise<boolean> {
		await this.check(context, signal, session);
		const decision = await context.ensurePermissions(session.app, signal);
		await this.check(context, signal, session);
		// A system settings interaction makes the previous screenshot stale, even
		// when the user ultimately declines setup. Never reuse it for pending input.
		if (decision.prompted) session.observation = undefined;
		if (!decision.approved) {
			this.stopSession(session.id);
			throw new ComputerSetupDeclined(decision.reason);
		}
		return decision.prompted;
	}
	execute(request: ToolHostRequest, context: ComputerContext): Promise<ToolResult> {
		const args = request.arguments;
		const signal = AbortSignal.any([context.signal, this.lifetime.signal]);
		const operation = this.queue
			.then(async (): Promise<ToolResult> => {
				await this.check(context, signal);
				if (request.name === 'computer_apps') {
					exact(args, [], ['query']);
					if (args.query !== undefined && !text(args.query, 256, true))
						throw new Error('Invalid application query.');
					const apps = await this.apps((args.query as string | undefined) ?? '', signal);
					await this.check(context, signal);
					const modelApps: { id: string; name: string }[] = [];
					let chars = 64;
					for (const { id, name } of apps.slice(0, 256)) {
						chars += JSON.stringify({ id, name }).length + 1;
						if (chars > MAX_MODEL_TEXT_CHARS) break;
						modelApps.push({ id, name });
					}
					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									apps: modelApps,
									truncated: apps.length > modelApps.length,
								}),
							},
						],
					};
				}
				if (request.name === 'computer_open') {
					exact(args, ['appId']);
					id(args.appId);
					let app = (await this.apps('', signal)).find((item) => item.id === args.appId);
					// Native registries bound broad discovery. An exact-ID search can still
					// locate an app the user discovered outside that initial page.
					if (!app)
						app = (await this.apps(args.appId.slice(0, 256), signal)).find(
							(item) => item.id === args.appId,
						);
					if (!app)
						throw new Error('This application is not in the host registry. Discover apps again.');
					await this.check(context, signal);
					const existing = [...this.sessions.values()].find(
						(item) =>
							item.runId === request.runId &&
							item.threadId === request.threadId &&
							item.app.id === app.id,
					);
					if (existing) {
						const activeSignal = AbortSignal.any([signal, existing.controller.signal]);
						await this.ensurePermissions(existing, context, activeSignal);
						existing.observation = undefined;
						await this.options.adapter.open(existing.app.id, activeSignal);
						return this.observe(existing, context, activeSignal);
					}
					if (this.sessions.size >= MAX_SESSIONS)
						throw new Error('Close a Computer Use session before opening another app.');
					const decision = await context.authorize(app, signal);
					const scope = await this.check(context, signal);
					if (decision.scopeFingerprint !== scope)
						throw new Error(
							'Computer Use permission changed while awaiting approval. Open the app again.',
						);
					if (!decision.approved)
						return {
							isError: true,
							approvalDenied: { reason: decision.reason },
							content: [
								{
									type: 'text',
									text: `${decision.reason} Do not retry without a new user request.`,
								},
							],
						};
					const session: Session = {
						id: randomUUID(),
						runId: request.runId,
						threadId: request.threadId,
						app,
						scope,
						controller: new AbortController(),
					};
					this.sessions.set(session.id, session);
					const activeSignal = AbortSignal.any([signal, session.controller.signal]);
					try {
						await this.ensurePermissions(session, context, activeSignal);
						await this.options.adapter.open(app.id, activeSignal);
						return await this.observe(session, context, activeSignal);
					} catch (error) {
						this.stopSession(session.id);
						throw error;
					}
				}
				exact(
					args,
					request.name === 'computer_act' ? ['sessionId', 'frameId', 'action'] : ['sessionId'],
				);
				id(args.sessionId);
				const session = this.sessions.get(args.sessionId);
				if (!session || session.runId !== request.runId || session.threadId !== request.threadId)
					throw new Error('This Computer Use session is unavailable or belongs to another task.');
				const activeSignal = AbortSignal.any([signal, session.controller.signal]);
				await this.check(context, activeSignal, session);
				if (request.name === 'computer_close') {
					this.stopSession(session.id);
					return {
						computer: { sessionId: session.id, app: session.app },
						content: [
							{ type: 'text', text: 'Computer Use access revoked. The application remains open.' },
						],
					};
				}
				if (request.name === 'computer_observe')
					return this.observe(session, context, activeSignal);
				if (request.name !== 'computer_act') throw new Error('Unknown Computer Use tool.');
				id(args.frameId);
				const frame = session.observation;
				if (!frame || frame.frameId !== args.frameId)
					throw new Error('The frame is stale. Observe the approved app again before acting.');
				const nextAction = action(args.action, frame);
				if (await this.ensurePermissions(session, context, activeSignal))
					return this.observe(
						session,
						context,
						activeSignal,
						'OS permission setup interrupted this action. The action was not dispatched. Inspect this refreshed observation before choosing a new action.',
						true,
					);
				// Consume before dispatch, including failures: never replay an uncertain native action.
				session.observation = undefined;
				try {
					await this.options.adapter.act(session.app.id, frame.frameId, nextAction, activeSignal);
				} catch (error) {
					if (await this.ensurePermissions(session, context, activeSignal))
						return this.observe(
							session,
							context,
							activeSignal,
							'The native action failed while OS permissions changed and was not replayed. Inspect this refreshed observation before choosing a new action.',
							true,
						);
					throw error;
				}
				return this.observe(session, context, activeSignal);
			})
			.catch((error: unknown): ToolResult => {
				if (!(error instanceof ComputerSetupDeclined)) throw error;
				return {
					isError: true,
					approvalDenied: { reason: error.message },
					content: [
						{ type: 'text', text: `${error.message} Do not retry without a new user request.` },
					],
				};
			});
		this.queue = operation.catch(() => {});
		return operation;
	}
	async close(): Promise<void> {
		this.lifetime.abort();
		for (const session of this.sessions.values()) this.stopSession(session.id);
		await this.options.adapter.close();
		this.previews.clear();
	}
}
