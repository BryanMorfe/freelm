import { validProjectDirectories } from '../src/lib/project-directories';
import { MAX_GENERATED_VIDEO_CHARS } from '../src/lib/generated-video';
import { jsonLengthAtMost } from '../src/json-normalize';
import { validModerationWarnings } from '../src/lib/moderation-warnings';
import { searxngSearchUrl } from '../src/lib/web-tools';
import type {
	AgentTranscript,
	ToolCallRecord,
	ToolHostRequest,
	ToolSettings,
} from '../src/agent-types';

const record = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string =>
	typeof v === 'string' && v.length <= max && !v.includes('\0');
const id = (v: unknown) => text(v, 256) && !!v;

export function validOutputFileChanges(v: unknown): boolean {
	const absolute = (value: unknown) =>
		text(value, 4096) && !!value && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
	const finite = (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0;
	return (
		Array.isArray(v) &&
		v.length <= 1000 &&
		v.every(
			(entry) =>
				record(entry) &&
				['add', 'update', 'delete', 'move'].includes(String(entry.kind)) &&
				absolute(entry.path) &&
				(entry.previousPath === undefined || absolute(entry.previousPath)) &&
				(entry.kind !== 'move' ||
					(absolute(entry.previousPath) && entry.previousPath !== entry.path)) &&
				(entry.size === undefined ||
					(Number.isSafeInteger(entry.size) && (entry.size as number) >= 0)) &&
				(entry.modifiedAt === undefined || finite(entry.modifiedAt)),
		)
	);
}

export function validateToolSettings(v: unknown): asserts v is ToolSettings {
	if (
		!record(v) ||
		typeof v.enabled !== 'boolean' ||
		!text(v.workspaceRoot) ||
		(v.workspaceRoots !== undefined && !validProjectDirectories(v.workspaceRoots)) ||
		typeof v.commandExecution !== 'boolean' ||
		!['ask', 'auto-review', 'full-access', 'trusted'].includes(String(v.approvalMode)) ||
		(v.workspacePathsUnrestricted !== undefined &&
			typeof v.workspacePathsUnrestricted !== 'boolean') ||
		(v.allowRemote !== undefined && typeof v.allowRemote !== 'boolean') ||
		!record(v.imageGeneration) ||
		typeof v.imageGeneration.enabled !== 'boolean' ||
		!text(v.imageGeneration.connectionId, 256) ||
		!text(v.imageGeneration.model, 1024) ||
		!text(v.imageGeneration.size, 128) ||
		!text(v.imageGeneration.quality, 128) ||
		!Array.isArray(v.skillDirectories) ||
		v.skillDirectories.length > 32 ||
		!v.skillDirectories.every((p) => text(p) && p.trim()) ||
		!Array.isArray(v.mcpServers) ||
		v.mcpServers.length > 32
	)
		throw new Error('Invalid tool settings.');
	if (
		v.videoGeneration !== undefined &&
		(!record(v.videoGeneration) ||
			typeof v.videoGeneration.enabled !== 'boolean' ||
			!text(v.videoGeneration.connectionId, 256) ||
			!text(v.videoGeneration.model, 1024) ||
			!text(v.videoGeneration.size, 128) ||
			!text(v.videoGeneration.seconds, 32))
	)
		throw new Error('Invalid video generation settings.');
	if (
		v.pythonExecution !== undefined &&
		(!record(v.pythonExecution) ||
			typeof v.pythonExecution.enabled !== 'boolean' ||
			Object.keys(v.pythonExecution).some((key) => key !== 'enabled'))
	)
		throw new Error('Invalid Python execution settings.');
	if (
		v.computerUse !== undefined &&
		(!record(v.computerUse) ||
			typeof v.computerUse.enabled !== 'boolean' ||
			Object.keys(v.computerUse).some((key) => key !== 'enabled'))
	)
		throw new Error('Invalid Computer Use settings.');
	if (v.webBrowsing !== undefined) {
		if (
			!record(v.webBrowsing) ||
			typeof v.webBrowsing.enabled !== 'boolean' ||
			!text(v.webBrowsing.searxngUrl, 2048) ||
			(v.webBrowsing.mode !== undefined &&
				!['builtin', 'external'].includes(String(v.webBrowsing.mode))) ||
			(v.webBrowsing.autoStart !== undefined && typeof v.webBrowsing.autoStart !== 'boolean') ||
			(v.webBrowsing.engines !== undefined &&
				(!Array.isArray(v.webBrowsing.engines) ||
					v.webBrowsing.engines.length > 128 ||
					!v.webBrowsing.engines.every(
						(name) => text(name, 100) && name.trim() === name && !!name,
					) ||
					new Set(v.webBrowsing.engines).size !== v.webBrowsing.engines.length))
		)
			throw new Error('Invalid web browsing settings.');
		if (v.webBrowsing.enabled && v.webBrowsing.mode !== 'builtin')
			searxngSearchUrl(v.webBrowsing.searxngUrl);
		if (
			v.webBrowsing.enabled &&
			v.webBrowsing.mode === 'builtin' &&
			Array.isArray(v.webBrowsing.engines) &&
			!v.webBrowsing.engines.length
		)
			throw new Error('Choose at least one search engine before enabling built-in browsing.');
	}
	const ids = new Set<string>();
	for (const s of v.mcpServers) {
		if (
			!record(s) ||
			!id(s.id) ||
			ids.has(String(s.id)) ||
			!text(s.name, 256) ||
			!s.name.trim() ||
			typeof s.enabled !== 'boolean' ||
			!['stdio', 'http'].includes(String(s.transport)) ||
			(s.command !== undefined && !text(s.command)) ||
			(s.url !== undefined && !text(s.url, 8192)) ||
			(s.args !== undefined &&
				(!Array.isArray(s.args) || s.args.length > 128 || !s.args.every((a) => text(a)))) ||
			(s.bearerTokenEnv !== undefined &&
				(!text(s.bearerTokenEnv, 256) ||
					(s.bearerTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.bearerTokenEnv)))) ||
			(s.env !== undefined &&
				(!record(s.env) ||
					Object.keys(s.env).length > 64 ||
					!Object.entries(s.env).every(
						([k, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && text(value, 8192),
					)))
		)
			throw new Error('Invalid MCP server settings.');
		ids.add(String(s.id));
		if (s.enabled && s.transport === 'stdio' && (!s.command || !String(s.command).trim()))
			throw new Error('An enabled stdio server needs a command.');
		if (s.enabled && s.transport === 'http') {
			const url = new URL(String(s.url));
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
				throw new Error('MCP requires an HTTP(S) URL without embedded credentials.');
		}
	}
}

export function validateToolRequest(v: unknown): asserts v is ToolHostRequest {
	function invalid(detail: string): never {
		throw new Error(`Invalid tool request: ${detail}`);
	}
	if (!record(v)) invalid('Expected an object.');
	for (const field of ['workspaceId', 'runId', 'threadId', 'name'])
		if (!id(v[field])) invalid(`${field} must be a nonempty string of at most 256 characters.`);
	if (!record(v.arguments)) invalid('arguments must be an object.');
	if (!jsonLengthAtMost(v.arguments, 1_000_000))
		invalid('arguments must be valid JSON of at most 1,000,000 characters.');
	if (v.recentImages === undefined) return;
	if (!Array.isArray(v.recentImages) || v.recentImages.length > 5)
		invalid('recentImages must be an array containing at most five images.');
	for (const [index, image] of v.recentImages.entries()) {
		const field = `recentImages[${index}]`;
		if (!record(image)) invalid(`${field} must be an image attachment.`);
		if (!text(image.name, 1024)) invalid(`${field}.name must be at most 1,024 characters.`);
		if (!text(image.type, 128) || !/^image\/[a-z0-9.+-]+$/i.test(image.type))
			invalid(`${field}.type must be an image MIME type.`);
		if (!text(image.dataUrl, 45_000_000))
			invalid(`${field}.dataUrl must be an embedded image of at most 45,000,000 characters.`);
		// This boundary validates transport, not a provider's image format support.
		// AVIF and other image attachments must reach the same moderation/provider
		// checks as playground uploads, without changing or dropping their bytes.
		if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(image.dataUrl))
			invalid(`${field}.dataUrl must be a base64 image data URL.`);
	}
}

export function validToolRecords(v: unknown): v is ToolCallRecord[] {
	return (
		Array.isArray(v) &&
		v.every(
			(c) =>
				record(c) &&
				id(c.id) &&
				id(c.name) &&
				text(c.arguments, 1_000_000) &&
				['running', 'approval', 'completed', 'failed', 'denied'].includes(String(c.status)) &&
				typeof c.startedAt === 'number' &&
				Number.isFinite(c.startedAt) &&
				(c.result === undefined ||
					(record(c.result) &&
						(c.result.moderationWarnings === undefined ||
							validModerationWarnings(c.result.moderationWarnings)) &&
						(c.result.outputFiles === undefined || validOutputFileChanges(c.result.outputFiles)) &&
						(c.result.outputTrackingNotices === undefined ||
							(Array.isArray(c.result.outputTrackingNotices) &&
								c.result.outputTrackingNotices.length <= 100 &&
								c.result.outputTrackingNotices.every((notice) => text(notice, 4096)))) &&
						(c.result.approvalDenied === undefined ||
							(record(c.result.approvalDenied) &&
								text(c.result.approvalDenied.reason, 1_000_000) &&
								!!c.result.approvalDenied.reason.trim() &&
								(c.result.approvalDenied.permissionMode === undefined ||
									['ask', 'auto-review', 'full-access'].includes(
										String(c.result.approvalDenied.permissionMode),
									)) &&
								(c.result.approvalDenied.effectiveDirectory === undefined ||
									text(c.result.approvalDenied.effectiveDirectory, 4096)))) &&
						(c.result.approvalReviewError === undefined ||
							(record(c.result.approvalReviewError) &&
								text(c.result.approvalReviewError.reason, 1_000_000) &&
								!!c.result.approvalReviewError.reason.trim() &&
								['configuration', 'context', 'unavailable', 'invalid_response'].includes(
									String(c.result.approvalReviewError.code),
								) &&
								Number.isSafeInteger(c.result.approvalReviewError.attempts) &&
								Number(c.result.approvalReviewError.attempts) >= 0 &&
								Number(c.result.approvalReviewError.attempts) <= 5 &&
								(c.result.approvalReviewError.permissionMode === undefined ||
									['ask', 'auto-review', 'full-access'].includes(
										String(c.result.approvalReviewError.permissionMode),
									)) &&
								(c.result.approvalReviewError.effectiveDirectory === undefined ||
									text(c.result.approvalReviewError.effectiveDirectory, 4096)))) &&
						Array.isArray(c.result.content) &&
						c.result.content.length <= 100 &&
						c.result.content.every(
							(p) =>
								record(p) &&
								((p.type === 'text' && text(p.text, 1_000_000)) ||
									(p.type === 'file' &&
										text(p.name, 240) &&
										text(p.mimeType, 128) &&
										text(
											p.dataUrl,
											/^video\/[a-z0-9.+-]+$/i.test(String(p.mimeType))
												? MAX_GENERATED_VIDEO_CHARS
												: 12_000_000,
										) &&
										/^data:[a-zA-Z0-9.+\/-]+;base64,[A-Za-z0-9+/=]*$/.test(p.dataUrl)) ||
									(p.type === 'image' &&
										text(p.dataUrl, 45_000_000) &&
										/^data:image\/(png|jpeg|webp|gif);base64,/.test(p.dataUrl))),
						))),
		)
	);
}
export function validTranscript(v: unknown): v is AgentTranscript {
	return (
		record(v) &&
		['responses', 'chat'].includes(String(v.api)) &&
		Array.isArray(v.items) &&
		v.items.every(record) &&
		jsonLengthAtMost(v.items, 200_000_000) &&
		(v.context === undefined || validContextCheckpoint(v.context, v.items.length)) &&
		(v.usage === undefined || validContextUsage(v.usage)) &&
		(v.contextWindows === undefined ||
			(Array.isArray(v.contextWindows) &&
				v.contextWindows.length <= 100000 &&
				v.contextWindows.every(
					(window) =>
						record(window) &&
						id(window.id) &&
						Number.isSafeInteger(window.transcriptItemCount) &&
						(window.transcriptItemCount as number) >= 0 &&
						(window.transcriptItemCount as number) <= (v.items as unknown[]).length &&
						Array.isArray(window.historyMessageIds) &&
						window.historyMessageIds.every(id) &&
						Number.isSafeInteger(window.createdAt) &&
						(window.createdAt as number) >= 0 &&
						['compaction', 'reset'].includes(String(window.kind)),
				)))
	);
}

function validContextCheckpoint(v: unknown, transcriptLength: number): boolean {
	if (!record(v)) return false;
	const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
	return (
		v.version === 1 &&
		(v.kind === undefined || ['compaction', 'reset'].includes(String(v.kind))) &&
		['responses', 'chat'].includes(String(v.api)) &&
		text(v.model, 1024) &&
		!!v.model &&
		id(v.connectionId) &&
		Array.isArray(v.historyMessageIds) &&
		v.historyMessageIds.every(id) &&
		count(v.transcriptItemCount) &&
		(v.transcriptItemCount as number) <= transcriptLength &&
		Array.isArray(v.items) &&
		v.items.length > 0 &&
		v.items.every(record) &&
		jsonLengthAtMost(v.items, 200_000_000) &&
		count(v.createdAt) &&
		count(v.compactionCount) &&
		(v.compactionCount as number) > 0 &&
		count(v.inputTokensBefore) &&
		count(v.inputTokensAfter) &&
		(v.kind === 'reset' || (v.inputTokensAfter as number) < (v.inputTokensBefore as number))
	);
}

function validContextUsage(v: unknown): boolean {
	if (!record(v)) return false;
	return (
		v.version === 1 &&
		text(v.model, 1024) &&
		!!v.model &&
		id(v.connectionId) &&
		Array.isArray(v.historyMessageIds) &&
		v.historyMessageIds.every(id) &&
		Number.isSafeInteger(v.estimatedInputTokens) &&
		(v.estimatedInputTokens as number) >= 0 &&
		Number.isSafeInteger(v.inputTokens) &&
		(v.inputTokens as number) >= 0
	);
}
