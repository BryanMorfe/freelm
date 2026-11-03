import { validProviderAdapterBinding } from '../src/lib/connection-validation';
import { validBotResponseSound } from '../src/notification-types';
import { validComposerContext } from '../src/lib/composer-context';
import type { AppState, WireRequest } from '../src/types';
import { validProjectDirectories } from '../src/lib/project-directories';
import { isAppearanceSettings } from '../src/lib/appearance';
import { assertModelCatalog, assertThinkingPresets } from '../src/lib/catalog';
import { validateCodeCompactionSettings } from '../src/lib/code-compaction';
import { validCodeGoal } from '../src/lib/code-goals';
import { validModerationSettings } from '../src/lib/moderation';
import { validModerationWarnings } from '../src/lib/moderation-warnings';
import {
	MAX_CODE_QUEUE_FAILURES,
	MAX_CODE_QUEUE_FAILURE_MESSAGE_IDS,
	MAX_CODE_QUEUE_FAILURE_ERROR,
} from '../src/lib/code-queue';
import { validateToolSettings, validToolRecords, validTranscript } from './agent-validation';
import { MAX_MEMORY_CONTENT, MAX_MEMORY_SUMMARY, MAX_SAVED_MEMORIES } from '../src/memory-types';
import {
	MAX_CUSTOM_INSTRUCTIONS,
	PERSONALITIES,
	PERSONALIZATION_LEVELS,
} from '../src/personalization-types';

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 100_000): value is string {
	return typeof value === 'string' && value.length <= max;
}

function timestamp(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function identifier(value: unknown): boolean {
	return text(value, 256) && value.trim().length > 0;
}

function replyReference(value: unknown): boolean {
	return (
		record(value) &&
		identifier(value.messageId) &&
		text(value.text, 100_000) &&
		value.text.trim().length > 0
	);
}

function queuedCodeMessages(value: unknown): boolean {
	return (
		items(
			value,
			(message) =>
				identifier(message.id) &&
				text(message.content, 2_000_000) &&
				timestamp(message.createdAt) &&
				(message.replyTo === undefined || replyReference(message.replyTo)) &&
				(message.composer === undefined || validComposerContext(message.composer)) &&
				(message.attachments === undefined ||
					items(
						message.attachments,
						(attachment) =>
							text(attachment.name, 1024) &&
							text(attachment.type, 256) &&
							text(attachment.dataUrl, 100_000_000),
						6,
					)) &&
				((message.content as string).trim().length > 0 ||
					(Array.isArray(message.attachments) && message.attachments.length > 0)),
			10000,
		) &&
		new Set((value as { id: string }[]).map((message) => message.id)).size ===
			(value as unknown[]).length
	);
}

function codeQueueReferences(
	value: Record<string, unknown>,
	messages: ReadonlyMap<string, string>,
): boolean {
	return (
		identifier(value.assistantId) &&
		messages.get(value.assistantId as string) === 'assistant' &&
		Array.isArray(value.messageIds) &&
		value.messageIds.length > 0 &&
		value.messageIds.length <= MAX_CODE_QUEUE_FAILURE_MESSAGE_IDS &&
		value.messageIds.every((id) => identifier(id) && messages.get(id) === 'user') &&
		new Set(value.messageIds).size === value.messageIds.length
	);
}

function codeQueueMetadata(thread: Record<string, unknown>): boolean {
	if (thread.codeQueueFailures === undefined && thread.codeQueueDelivery === undefined) return true;
	if (thread.kind === 'chat' || !Array.isArray(thread.messages)) return false;
	const messages = new Map<string, string>();
	for (const message of [
		...(Array.isArray(thread.messageHistory) ? thread.messageHistory : []),
		...thread.messages,
	])
		if (record(message) && typeof message.id === 'string' && typeof message.role === 'string')
			messages.set(message.id, message.role);
	const failures = thread.codeQueueFailures;
	if (failures !== undefined) {
		const ids = new Set<string>(),
			assistants = new Set<string>(),
			users = new Set<string>();
		if (
			!items(
				failures,
				(failure) => {
					if (!(
						Object.keys(failure).every((key) =>
							['id', 'assistantId', 'messageIds', 'error', 'failedAt'].includes(key),
						) &&
						identifier(failure.id) &&
						codeQueueReferences(failure, messages) &&
						text(failure.error, MAX_CODE_QUEUE_FAILURE_ERROR) &&
						failure.error.trim().length > 0 &&
						timestamp(failure.failedAt)
					))
						return false;
					const id = failure.id as string,
						assistantId = failure.assistantId as string,
						messageIds = failure.messageIds as string[];
					if (
						ids.has(id) ||
						assistants.has(assistantId) ||
						messageIds.some((messageId) => users.has(messageId))
					)
						return false;
					ids.add(id);
					assistants.add(assistantId);
					messageIds.forEach((messageId) => users.add(messageId));
					return true;
				},
				MAX_CODE_QUEUE_FAILURES,
			)
		)
			return false;
	}
	const delivery = thread.codeQueueDelivery;
	return (
		delivery === undefined ||
		(record(delivery) &&
			Object.keys(delivery).every((key) =>
				['assistantId', 'messageIds', 'startedAt'].includes(key),
			) &&
			codeQueueReferences(delivery, messages) &&
			timestamp(delivery.startedAt))
	);
}

function personalizationProfile(value: unknown): boolean {
	return (
		record(value) &&
		typeof value.personality === 'string' &&
		(PERSONALITIES as readonly string[]).includes(value.personality) &&
		['warmth', 'enthusiasm', 'responseLength', 'formatting', 'emojis'].every(
			(key) =>
				typeof value[key] === 'string' &&
				(PERSONALIZATION_LEVELS as readonly string[]).includes(value[key] as string),
		) &&
		text(value.customInstructions, MAX_CUSTOM_INSTRUCTIONS)
	);
}

function memorySummary(value: unknown): boolean {
	return (
		record(value) &&
		text(value.content, MAX_MEMORY_SUMMARY) &&
		value.content.trim().length > 0 &&
		identifier(value.sourceRevision) &&
		timestamp(value.generatedAt) &&
		text(value.model, 1024) &&
		value.model.trim().length > 0
	);
}

function savedMemories(value: unknown): boolean {
	return (
		items(
			value,
			(entry) =>
				identifier(entry.id) &&
				text(entry.content, MAX_MEMORY_CONTENT) &&
				entry.content.trim().length > 0 &&
				(entry.projectId === undefined || identifier(entry.projectId)) &&
				timestamp(entry.createdAt) &&
				timestamp(entry.updatedAt) &&
				Number.isSafeInteger(entry.revision) &&
				(entry.revision as number) >= 1 &&
				(entry.source === 'user' || entry.source === 'model') &&
				(entry.sourceThreadId === undefined || identifier(entry.sourceThreadId)),
			MAX_SAVED_MEMORIES,
		) &&
		new Set((value as { id: string }[]).map((entry) => entry.id)).size ===
			(value as unknown[]).length
	);
}

function items(
	value: unknown,
	check: (value: Record<string, unknown>) => boolean,
	max = 100_000,
	trusted?: ReadonlySet<object>,
): boolean {
	return (
		Array.isArray(value) &&
		value.length <= max &&
		value.every((item) => record(item) && (trusted?.has(item) || check(item)))
	);
}

/** Previous is a private immutable canonical snapshot, never caller-supplied input. */
export function validateState(value: unknown, previous?: AppState): asserts value is AppState {
	const knownConnections = previous && new Set(previous.connections);
	const knownProjects = previous && new Set(previous.projects);
	const knownThreads = previous && new Set(previous.threads);
	const knownGenerations = previous && new Set(previous.generations);
	const oldMessages = previous?.threads.flatMap((thread) => [
		...thread.messages,
		...(thread.messageHistory ?? []),
	]);
	const knownMessages = oldMessages && new Set(oldMessages);
	const knownTranscripts =
		oldMessages && new Set(oldMessages.map((message) => message.agentTranscript).filter(Boolean));
	const knownToolCalls =
		oldMessages && new Set(oldMessages.map((message) => message.toolCalls).filter(Boolean));
	const validMessage = (m: Record<string, unknown>) =>
		text(m.id, 256) &&
		['user', 'assistant'].includes(String(m.role)) &&
		text(m.content, 20_000_000) &&
		timestamp(m.createdAt) &&
		(m.parentId === undefined || m.parentId === null || identifier(m.parentId)) &&
		(m.replyTo === undefined || replyReference(m.replyTo)) &&
		(m.composer === undefined || validComposerContext(m.composer)) &&
		(m.activityFinishedAt === undefined || timestamp(m.activityFinishedAt)) &&
		(m.completedAt === undefined || timestamp(m.completedAt)) &&
		(m.phase === undefined ||
			['working', 'responding', 'tools', 'compacting'].includes(String(m.phase))) &&
		(m.activity === undefined ||
			items(
				m.activity,
				(part) =>
					text(part.id, 256) &&
					(part.type === 'text'
						? text(part.text, 2_000_000)
						: part.type === 'tool' && text(part.toolCallId, 512)),
				Number.MAX_SAFE_INTEGER,
			)) &&
		(m.error === undefined || text(m.error)) &&
		(m.interrupted === undefined || typeof m.interrupted === 'boolean') &&
		(m.model === undefined || text(m.model, 1024)) &&
		(m.thinkingMode === undefined || text(m.thinkingMode, 256)) &&
		(m.toolCalls === undefined ||
			knownToolCalls?.has(m.toolCalls as never) ||
			validToolRecords(m.toolCalls)) &&
		(m.agentTranscript === undefined ||
			knownTranscripts?.has(m.agentTranscript as never) ||
			validTranscript(m.agentTranscript)) &&
		(m.attachments === undefined ||
			items(
				m.attachments,
				(a) => text(a.name, 1024) && text(a.type, 256) && text(a.dataUrl, 100_000_000),
				100,
			));
	if (record(value) && value.toolSettings !== undefined) validateToolSettings(value.toolSettings);
	if (record(value) && value.moderation !== undefined && !validModerationSettings(value.moderation))
		throw new Error('Moderation settings are invalid. Your saved file has not been changed.');
	if (record(value) && value.codeCompaction !== undefined) {
		if (
			!record(value.codeCompaction) ||
			typeof value.codeCompaction.thresholdPercent !== 'number' ||
			typeof value.codeCompaction.reserveTokens !== 'number'
		)
			throw new Error(
				'Code compaction settings are invalid. Your saved file has not been changed.',
			);
		validateCodeCompactionSettings(value.codeCompaction);
	}
	if (
		!record(value) ||
		value.version !== 1 ||
		!text(value.activeConnectionId, 256) ||
		!['dark', 'light', 'system'].includes(String(value.theme)) ||
		(value.appearance !== undefined && !isAppearanceSettings(value.appearance)) ||
		(value.debugMode !== undefined && typeof value.debugMode !== 'boolean') ||
		(value.botResponseSound !== undefined && !validBotResponseSound(value.botResponseSound)) ||
		(value.backgroundNotifications !== undefined &&
			typeof value.backgroundNotifications !== 'boolean') ||
		(value.dictation !== undefined &&
			(!record(value.dictation) ||
				typeof value.dictation.enabled !== 'boolean' ||
				!text(value.dictation.connectionId, 256) ||
				!text(value.dictation.model, 1024) ||
				(value.dictation.enabled &&
					(!value.dictation.connectionId.trim() || !value.dictation.model.trim())))) ||
		(value.chatDrafts !== undefined &&
			(!record(value.chatDrafts) ||
				Object.keys(value.chatDrafts).length > 10000 ||
				Object.entries(value.chatDrafts).some(
					([key, draft]) =>
						!identifier(key) ||
						!record(draft) ||
						!text(draft.content, 2_000_000) ||
						(draft.replyTo !== undefined && !replyReference(draft.replyTo)) ||
						(draft.composer !== undefined && !validComposerContext(draft.composer)) ||
						!timestamp(draft.updatedAt) ||
						!items(
							draft.attachments,
							(a) => text(a.name, 1024) && text(a.type, 256) && text(a.dataUrl, 100_000_000),
							100,
						),
				))) ||
		(value.systemPrompt !== undefined && !text(value.systemPrompt)) ||
		(value.personalization !== undefined &&
			(!record(value.personalization) ||
				!personalizationProfile(value.personalization.chat) ||
				!personalizationProfile(value.personalization.code))) ||
		(value.memorySettings !== undefined &&
			(!record(value.memorySettings) ||
				typeof value.memorySettings.savedMemories !== 'boolean' ||
				typeof value.memorySettings.referenceHistory !== 'boolean')) ||
		(value.savedMemories !== undefined && !savedMemories(value.savedMemories)) ||
		!items(
			value.connections,
			(c) =>
				text(c.id, 256) &&
				text(c.name, 512) &&
				text(c.baseUrl, 4096) &&
				text(c.apiKey, 16_384) &&
				(c.providerAdapter === undefined || (validProviderAdapterBinding(c.providerAdapter) && c.chatApi === 'chat/completions')) &&
				['responses', 'chat/completions', 'chat'].includes(String(c.chatApi)) &&
				record(c.models) &&
				['chat', 'images', 'videos', 'speech', 'transcription'].every((key) =>
					text((c.models as Record<string, unknown>)[key], 1024),
				) &&
				Array.isArray(c.discoveredModels) &&
				c.discoveredModels.length <= 50_000 &&
				c.discoveredModels.every((model) => text(model, 1024)),
			1000,
			knownConnections,
		) ||
		!items(
			value.projects,
			(p) =>
				text(p.id, 256) &&
				text(p.name, 512) &&
				text(p.instructions) &&
				timestamp(p.createdAt) &&
				(p.kind === undefined || p.kind === 'chat' || p.kind === 'code') &&
				(p.directories === undefined ||
					(validProjectDirectories(p.directories) &&
						(p.kind !== 'chat' || p.directories.length === 0))),
			100_000,
			knownProjects,
		) ||
		!items(
			value.threads,
			(t) =>
				text(t.id, 256) &&
				(t.kind === undefined || t.kind === 'chat' || t.kind === 'code') &&
				text(t.title, 4096) &&
				(t.titleSource === undefined ||
					['pending', 'generated', 'manual'].includes(String(t.titleSource))) &&
				text(t.connectionId, 256) &&
				text(t.model, 1024) &&
				(t.thinkingMode === undefined || text(t.thinkingMode, 256)) &&
				(t.permissionMode === undefined ||
					['ask', 'auto-review', 'full-access'].includes(String(t.permissionMode))) &&
				(t.projectId === undefined || text(t.projectId, 256)) &&
				(t.pinned === undefined || typeof t.pinned === 'boolean') &&
				(t.temporary === undefined || typeof t.temporary === 'boolean') &&
				(t.archivedAt === undefined || timestamp(t.archivedAt)) &&
				(t.branchedFrom === undefined ||
					(record(t.branchedFrom) &&
						identifier(t.branchedFrom.threadId) &&
						identifier(t.branchedFrom.messageId))) &&
				(t.messageHistory === undefined ||
					items(t.messageHistory, validMessage, 100_000, knownMessages)) &&
				(t.queuedMessages === undefined || queuedCodeMessages(t.queuedMessages)) &&
				(t.goal === undefined || (t.kind !== 'chat' && validCodeGoal(t.goal))) &&
				codeQueueMetadata(t) &&
				(t.memorySummary === undefined || memorySummary(t.memorySummary)) &&
				timestamp(t.createdAt) &&
				timestamp(t.updatedAt) &&
				items(t.messages, validMessage, 100_000, knownMessages),
			100_000,
			knownThreads,
		) ||
		!items(
			value.generations,
			(g) =>
				text(g.id, 256) &&
				['images', 'videos', 'speech', 'transcription'].includes(String(g.kind)) &&
				text(g.prompt, 20_000_000) &&
				text(g.model, 1024) &&
				text(g.connectionId, 256) &&
				timestamp(g.createdAt) &&
				['pending', 'completed', 'failed', 'cancelled'].includes(String(g.status)) &&
				items(
					g.assets,
					(a) => text(a.url, 400_000_000) && text(a.mimeType, 256) && text(a.name, 1024),
					1000,
				) &&
				(g.text === undefined || text(g.text, 20_000_000)) &&
				(g.error === undefined || text(g.error)) &&
				(g.moderationWarnings === undefined || validModerationWarnings(g.moderationWarnings)) &&
				(g.remoteId === undefined || text(g.remoteId, 1024)) &&
				(g.progress === undefined ||
					(typeof g.progress === 'number' && Number.isFinite(g.progress))) &&
				(g.parameters === undefined ||
					(record(g.parameters) &&
						Object.values(g.parameters).every(
							(v) => text(v) || (typeof v === 'number' && Number.isFinite(v)),
						))),
			100_000,
			knownGenerations,
		)
	) {
		throw new Error(
			'Workspace data is invalid or uses an unsupported version. Your saved file has not been changed.',
		);
	}
	const connections = value.connections as { id: string }[];
	if (value.thinkingPresets !== undefined) {
		try {
			assertThinkingPresets(value.thinkingPresets);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : 'Invalid thinking presets.'} Your saved file has not been changed.`,
			);
		}
	}
	for (const connection of value.connections as Record<string, unknown>[]) {
		if (knownConnections?.has(connection as never)) continue;
		if (connection.catalog !== undefined) {
			try {
				assertModelCatalog(connection.catalog);
			} catch (error) {
				throw new Error(
					`${connection.name}: ${error instanceof Error ? error.message : 'Invalid model catalog.'} Your saved file has not been changed.`,
				);
			}
		}
	}
	if (
		!connections.length ||
		!connections.some((connection) => connection.id === value.activeConnectionId) ||
		new Set(connections.map((connection) => connection.id)).size !== connections.length
	) {
		throw new Error(
			'Workspace must contain distinct connections and a valid active connection. Your saved file has not been changed.',
		);
	}
}

export function validateRequest(value: unknown): asserts value is WireRequest {
	if (
		!record(value) ||
		!text(value.id, 256) ||
		!value.id ||
		!text(value.baseUrl, 4096) ||
		!text(value.apiKey, 16_384) ||
		!text(value.path, 4096) ||
		!['GET', 'POST'].includes(String(value.method)) ||
		(value.body !== undefined && !record(value.body)) ||
		(value.stream !== undefined && typeof value.stream !== 'boolean') ||
		(value.providerAdapterRequired !== undefined && typeof value.providerAdapterRequired !== 'boolean') ||
		(value.providerCaller !== undefined && (!record(value.providerCaller) || !['chat','code','bot'].includes(String(value.providerCaller.surface)))) ||
		(value.form !== undefined &&
			!items(
				value.form,
				(field) =>
					text(field.name, 256) &&
					Boolean(field.name) &&
					((text(field.value, 20_000_000) && field.file === undefined) ||
						(field.value === undefined &&
							record(field.file) &&
							text(field.file.name, 1024) &&
							text(field.file.type, 256) &&
							text(field.file.base64, 200_000_000))),
				100,
			))
	) {
		throw new Error('Invalid API request.');
	}
	if (value.body !== undefined && value.form !== undefined)
		throw new Error('Send JSON or form data, not both.');
}

export function validateRequestId(value: unknown): asserts value is string {
	if (!text(value, 256) || !value) throw new Error('Invalid request identifier.');
}
