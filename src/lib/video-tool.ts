import type { Attachment, Connection, ConversationKind, WireRequest, WireResponse } from '../types';
import type { ToolDefinition, ToolResult, ToolSettings } from '../agent-types';
import { getModelDefinition } from './catalog';
import { chatVideoTools } from './conversation-tools';
import { videoTool } from './interaction-tools';
import { DEFAULT_VIDEO_SIZE, normalizeVideoResolution } from './video-resolution';

type VideoConfig = NonNullable<ToolSettings['videoGeneration']>;
type Execute = (
	request: WireRequest,
	onChunk: (text: string) => void,
	signal?: AbortSignal,
) => Promise<WireResponse>;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
// The moderation guard may replace up to three URL aliases with approved snapshots.
const MAX_VIDEO_JOB_CHARACTERS = 3 * (Math.ceil(MAX_VIDEO_BYTES / 3) * 4 + 128) + 1_000_000;
export const VIDEO_TOOL_POLL_MS = 5000;

export function resolveVideoToolSize(value: unknown, defaultSize: string): string {
	const supplied = typeof value === 'string' ? value.trim() : value;
	const input =
		supplied === undefined || supplied === '' ? defaultSize.trim() || DEFAULT_VIDEO_SIZE : supplied;
	if (typeof input !== 'string' || input.length > 128)
		throw new Error('Video size must be WIDTHxHEIGHT in pixels.');
	const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(input.trim());
	if (
		!match ||
		!match
			.slice(1)
			.map(Number)
			.every((n) => Number.isSafeInteger(n) && n > 0)
	)
		throw new Error('Video size must contain positive whole-number dimensions: WIDTHxHEIGHT.');
	const normalized = normalizeVideoResolution(input);
	if (
		!normalized
			.split('x')
			.map(Number)
			.every((n) => Number.isSafeInteger(n) && n > 0 && n % 32 === 0)
	)
		throw new Error('Video dimensions are too large.');
	return normalized;
}

export function resolveVideoToolSeconds(
	value: unknown,
	defaultSeconds: string,
): string | undefined {
	const input = value === undefined ? defaultSeconds.trim() : value;
	if (input === '') return undefined;
	if (typeof input !== 'string' && typeof input !== 'number')
		throw new Error('Video duration must be a positive number of seconds.');
	const text = String(input).trim();
	if (
		text.length > 32 ||
		!/^\d+(?:\.\d+)?$/.test(text) ||
		!Number.isFinite(Number(text)) ||
		Number(text) <= 0
	)
		throw new Error('Video duration must be a positive number of seconds.');
	return String(Number(text));
}

export function configuredVideoTool(
	connection: Connection | undefined,
	config: VideoConfig,
	kind: ConversationKind,
): ToolDefinition {
	const tool = structuredClone(videoTool);
	const model = connection && getModelDefinition(connection, config.model);
	const selected = `Selected video model: ${model ? `${model.name} (${model.id})` : config.model.trim() || 'Not selected'}.`;
	const properties = tool.parameters.properties as Record<string, { description?: string }>;
	properties.size.description += ` ${selected} ${config.size.trim() ? `Saved default size: ${config.size.trim()}.` : `Default size: ${DEFAULT_VIDEO_SIZE}.`} No additional supported resolutions are implied by these defaults.`;
	properties.seconds.description += ` ${selected} ${config.seconds.trim() ? `Saved default duration: ${config.seconds.trim()} seconds.` : 'No default duration is configured.'}`;
	tool.description += `\n${selected}`;
	return kind === 'chat' ? chatVideoTools([tool])[0] : tool;
}

function parseJob(
	response: WireResponse,
	guardedCreation = false,
): { id: string; status: string; error?: unknown; inlineContent?: WireResponse } {
	if (
		response.encoding !== 'text' ||
		!/json/i.test(response.contentType) ||
		response.body.length > MAX_VIDEO_JOB_CHARACTERS
	)
		throw new Error(`Video API returned an unsupported job response (HTTP ${response.status}).`);
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(response.body);
		if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
	} catch {
		throw new Error('Video API returned invalid JSON.');
	}
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			videoError(data.error ?? data.message, `Video API returned HTTP ${response.status}.`),
		);
	if (
		typeof data.id !== 'string' ||
		!data.id.trim() ||
		data.id.length > 1024 ||
		/[\u0000-\u001f\u007f/\\%]/.test(data.id) ||
		data.id === '.' ||
		data.id === '..'
	)
		throw new Error('Video API returned a job without a usable ID.');
	let inlineContent: WireResponse | undefined;
	if (guardedCreation) {
		// Only POST /videos goes through output moderation for inline job assets.
		// A status GET's inline URLs are never considered approved output.
		const inline = [data.video_url, data.download_url, data.url].find(
			(value) => typeof value === 'string' && value.startsWith('data:'),
		);
		if (typeof inline === 'string') {
			const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(inline);
			if (!match) throw new Error('Video API returned invalid inline video data.');
			inlineContent = {
				status: response.status,
				encoding: 'base64',
				contentType: match[1],
				body: match[2],
			};
		}
	}
	return {
		id: data.id,
		status: typeof data.status === 'string' ? data.status.toLowerCase() : 'queued',
		error: data.error,
		inlineContent,
	};
}

function videoError(value: unknown, fallback: string): string {
	if (typeof value === 'string' && value.trim()) return value.slice(0, 4096);
	if (
		value &&
		typeof value === 'object' &&
		'message' in value &&
		typeof value.message === 'string' &&
		value.message.trim()
	)
		return value.message.slice(0, 4096);
	return fallback;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const stop = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', stop);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop);
			resolve();
		}, VIDEO_TOOL_POLL_MS);
		signal.addEventListener('abort', stop, { once: true });
	});
}

/** Uses the host moderation executor for creation, polling and content release. Never follows provider URLs. */
export async function executeVideoGeneration(
	connection: Connection,
	options: {
		model: string;
		prompt: string;
		size?: string;
		seconds?: string;
		reference?: Attachment;
	},
	execute: Execute,
	signal: AbortSignal,
	checkCurrent: () => Promise<void> = async () => {},
): Promise<ToolResult> {
	const warnings = new Set<string>();
	const request = async (values: Pick<WireRequest, 'method' | 'path' | 'form'>) => {
		signal.throwIfAborted();
		await checkCurrent();
		signal.throwIfAborted();
		const response = await execute(
			{
				id: crypto.randomUUID(),
				baseUrl: connection.baseUrl,
				apiKey: connection.apiKey,
				...values,
			},
			() => {},
			signal,
		);
		signal.throwIfAborted();
		for (const warning of response.moderationWarnings ?? []) warnings.add(warning);
		return response;
	};
	const form: NonNullable<WireRequest['form']> = [
		{ name: 'model', value: options.model },
		{ name: 'prompt', value: options.prompt },
		{ name: 'size', value: resolveVideoToolSize(options.size, '') },
		...(options.seconds ? [{ name: 'seconds', value: options.seconds }] : []),
	];
	if (options.reference)
		form.push({
			name: 'input_reference',
			file: {
				name: options.reference.name,
				type: options.reference.type,
				base64: options.reference.dataUrl.slice(options.reference.dataUrl.indexOf(',') + 1),
			},
		});
	let jobId: string | undefined;
	let terminal = false;
	try {
		let job = parseJob(await request({ method: 'POST', path: '/videos', form }), true);
		jobId = job.id;
		for (;;) {
			signal.throwIfAborted();
			if (['failed', 'error', 'cancelled', 'canceled'].includes(job.status)) {
				terminal = true;
				throw new Error(videoError(job.error, `Video generation ${job.status}.`));
			}
			if (job.error) throw new Error(videoError(job.error, 'Video API returned an error.'));
			if (['completed', 'succeeded', 'success'].includes(job.status)) break;
			if (!['queued', 'pending', 'in_progress', 'processing', 'running'].includes(job.status))
				throw new Error(`Video API returned an unknown job status: ${job.status.slice(0, 120)}.`);
			// Jobs can exceed four hours on a slow backend. Only cancellation or a terminal provider status stops polling.
			await waitForPoll(signal);
			job = parseJob(
				await request({ method: 'GET', path: `/videos/${encodeURIComponent(jobId)}` }),
			);
			if (job.id !== jobId)
				throw new Error('Video API returned a different job ID while checking progress.');
		}
		const response =
			job.inlineContent ??
			(await request({
				method: 'GET',
				path: `/videos/${encodeURIComponent(jobId)}/content`,
			}));
		if (response.status < 200 || response.status >= 300)
			throw new Error(`Video download returned HTTP ${response.status}.`);
		const suppliedType = response.contentType.split(';')[0].trim().toLowerCase();
		const mimeType = suppliedType === 'application/octet-stream' ? 'video/mp4' : suppliedType;
		const decodedBytes =
			(response.body.length / 4) * 3 -
			(response.body.endsWith('==') ? 2 : response.body.endsWith('=') ? 1 : 0);
		if (
			response.encoding !== 'base64' ||
			!['video/mp4', 'video/webm', 'video/quicktime'].includes(mimeType) ||
			!response.body ||
			response.body.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4 ||
			response.body.length % 4 !== 0 ||
			decodedBytes > MAX_VIDEO_BYTES ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(response.body)
		)
			throw new Error('Video API returned unsupported or oversized video data (maximum 32 MiB).');
		const extension =
			mimeType === 'video/webm' ? 'webm' : mimeType === 'video/quicktime' ? 'mov' : 'mp4';
		return {
			content: [
				{ type: 'text', text: `Generated video with ${options.model}. Provider job: ${jobId}.` },
				...[...warnings].map((text) => ({ type: 'text' as const, text })),
				{
					type: 'file',
					dataUrl: `data:${mimeType};base64,${response.body}`,
					name: `generated-video-${crypto.randomUUID()}.${extension}`,
					mimeType,
				},
			],
			...(warnings.size ? { moderationWarnings: [...warnings] } : {}),
		};
	} catch (error) {
		if (!jobId || signal.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		// Preserve the moderation error class/diagnostic and the accepted ID; no duplicate submission is attempted.
		if (error instanceof Error) {
			error.message = `${message} Provider video job: ${jobId}.${terminal ? '' : ' The job may still be available at the provider; do not automatically submit it again.'}`;
			throw error;
		}
		throw new Error(`${message} Provider video job: ${jobId}.`);
	}
}
