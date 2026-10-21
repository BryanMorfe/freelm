import type { ToolCallRecord, ToolResult } from '../agent-types';
import type { Attachment, Message } from '../types';
import { researchDomain, researchUrl } from './research';

export interface ConversationSource {
	id: string;
	kind: 'upload' | 'web' | 'image' | 'local-image';
	title: string;
	url?: string;
	imageUrl?: string;
	path?: string;
	attachment?: Attachment;
	provided: boolean;
	searched: number;
	opened: number;
	viewed: number;
	read: boolean;
}
export interface ConversationSourceActivity {
	searches: number;
	opens: number;
	finds: number;
	views: number;
	failedCalls: number;
}
export interface ConversationSourcesData {
	items: ConversationSource[];
	web: ConversationSourceActivity;
	images: ConversationSourceActivity;
	hasSources: boolean;
	truncated: boolean;
}

const MAX_MESSAGES = 2_048;
const MAX_CALLS = 8_192;
const MAX_ITEMS = 256;
const MAX_ARGUMENTS = 65_536;
const MAX_RESULT_TEXT = 512_000;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const activity = (): ConversationSourceActivity => ({
	searches: 0,
	opens: 0,
	finds: 0,
	views: 0,
	failedCalls: 0,
});
const title = (value: unknown, fallback: string) =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;
const entries = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value) ? value.slice(0, 128).filter(record) : [];
const argumentCache = new WeakMap<
	ToolCallRecord,
	{ text: string; value: Record<string, unknown> }
>();
const resultCache = new WeakMap<ToolResult, { operations?: Record<string, unknown>[] }>();
interface OperationProof {
	searched: Set<string>;
	opened: Set<string>;
}
const proofCache = new WeakMap<ToolResult, OperationProof>();

function argumentsFor(call: ToolCallRecord): Record<string, unknown> {
	const cached = argumentCache.get(call);
	if (cached?.text === call.arguments) return cached.value;
	let value: Record<string, unknown> = {};
	try {
		if (call.arguments.length <= MAX_ARGUMENTS) {
			const parsed: unknown = JSON.parse(call.arguments);
			if (record(parsed)) value = parsed;
		}
	} catch {
		/* Streamed or imported tool arguments can be incomplete. */
	}
	argumentCache.set(call, { text: call.arguments, value });
	return value;
}
function operationResults(call: ToolCallRecord): Record<string, unknown>[] | undefined {
	if (!call.result) return;
	const cached = resultCache.get(call.result);
	if (cached) return cached.operations;
	let operations: Record<string, unknown>[] | undefined;
	for (const part of call.result?.content ?? []) {
		if (part.type !== 'text' || part.text.length > MAX_RESULT_TEXT) continue;
		try {
			const value: unknown = JSON.parse(part.text);
			if (record(value) && Array.isArray(value.results)) {
				operations = value.results
					.slice(0, 16)
					.filter(record)
					.filter((row) => typeof row.operation === 'string');
				break;
			}
		} catch {
			/* Legacy text outputs need no decoding to show their public source metadata. */
		}
	}
	resultCache.set(call.result, { operations });
	return operations;
}
function operationProof(
	call: ToolCallRecord,
	operations: Record<string, unknown>[] = [],
): OperationProof {
	if (call.result) {
		const cached = proofCache.get(call.result);
		if (cached) return cached;
	}
	const proof: OperationProof = { searched: new Set(), opened: new Set() };
	for (const row of operations) {
		if (row.error) continue;
		const refs = ['search_query', 'image_query'].includes(String(row.operation))
			? proof.searched
			: ['open', 'click'].includes(String(row.operation))
				? proof.opened
				: undefined;
		if (!refs) continue;
		for (const entry of [row, ...entries(row.results)]) {
			if (typeof entry.ref_id === 'string') refs.add(entry.ref_id);
			for (const value of [entry.url, entry.img_src]) {
				const url = researchUrl(value);
				if (url) refs.add(url);
			}
		}
	}
	if (call.result) proofCache.set(call.result, proof);
	return proof;
}
function trimmedUrl(value: string) {
	let result = value.replace(/[.,;!?`'"]+$/, '');
	for (const [open, close] of [
		['(', ')'],
		['[', ']'],
		['{', '}'],
	]) {
		while (result.endsWith(close) && result.split(close).length > result.split(open).length)
			result = result.slice(0, -1);
	}
	return result;
}

/** Sources belong to the selected conversation path, not its inactive response versions. */
export function collectConversationSources(
	messages: readonly Message[] = [],
): ConversationSourcesData {
	const data: ConversationSourcesData = {
		items: [],
		web: activity(),
		images: activity(),
		hasSources: false,
		truncated: messages.length > MAX_MESSAGES,
	};
	const sources = new Map<string, ConversationSource>();
	const uploadBuckets = new Map<string, ConversationSource[]>();
	const seenCalls = new Set<string>();
	let examinedCalls = 0;
	function source(key: string, kind: ConversationSource['kind'], name: string, url?: string) {
		let item = sources.get(key);
		if (!item) {
			if (sources.size >= MAX_ITEMS) {
				data.truncated = true;
				return;
			}
			item = {
				id: key,
				kind,
				title: name,
				url,
				provided: false,
				searched: 0,
				opened: 0,
				viewed: 0,
				read: false,
			};
			sources.set(key, item);
		}
		return item;
	}
	for (const message of messages.slice(-MAX_MESSAGES)) {
		for (const attachment of message.role === 'user'
			? (message.attachments?.slice(0, 128) ?? [])
			: []) {
			if (
				!attachment ||
				typeof attachment.name !== 'string' ||
				typeof attachment.type !== 'string' ||
				typeof attachment.dataUrl !== 'string'
			)
				continue;
			// Bucket on small metadata; never stringify or hash the potentially large image payload.
			const key = `${attachment.name}\0${attachment.type}\0${attachment.dataUrl.length}`;
			const bucket = uploadBuckets.get(key) ?? [];
			if (bucket.some((item) => item.attachment?.dataUrl === attachment.dataUrl)) continue;
			const item = source(
				`upload:${sources.size}:${attachment.name.slice(0, 300)}`,
				'upload',
				title(attachment.name, 'Attachment'),
			);
			if (!item) continue;
			item.attachment = attachment;
			item.provided = true;
			bucket.push(item);
			uploadBuckets.set(key, bucket);
		}
		if (message.role === 'user') {
			if (message.content.length > 100_000) data.truncated = true;
			const text = message.content.slice(0, 100_000);
			const matches = text.matchAll(/https?:\/\/[^\s<>"\u0000-\u001f]+/gi);
			let count = 0;
			for (const match of matches) {
				if (++count > 128) {
					data.truncated = true;
					break;
				}
				const url = researchUrl(trimmedUrl(match[0]));
				if (!url) continue;
				const prefix = text.slice(Math.max(0, match.index! - 205), match.index);
				const label = prefix.match(/\[([^\]\n]{1,200})\]\($/)?.[1];
				const item = source(`web:${url}`, 'web', title(label, researchDomain(url)), url);
				if (item) item.provided = true;
			}
		}
		for (const call of message.toolCalls ?? []) {
			if (++examinedCalls > MAX_CALLS) {
				data.truncated = true;
				break;
			}
			const callKey = `${message.id}\0${call.id}`;
			if (seenCalls.has(callKey)) continue;
			seenCalls.add(callKey);
			if (call.status !== 'completed' && call.status !== 'failed') continue;
			const succeeded = call.status === 'completed' && !call.result?.isError;
			const args = ['web.run', 'image.view', 'view_image'].includes(call.name)
				? argumentsFor(call)
				: {};
			const operations = call.name === 'web.run' ? operationResults(call) : undefined;
			const proof = operationProof(call, operations);
			const has = (names: string[]) => names.some((name) => entries(args[name]).length > 0);
			const success = (names: string[]) =>
				succeeded &&
				(operations?.length
					? operations.some((row) => names.includes(String(row.operation)) && !row.error)
					: has(names));
			const failed = (names: string[]) =>
				(!succeeded && has(names)) ||
				!!operations?.some((row) => names.includes(String(row.operation)) && !!row.error);
			if (call.name === 'web.run') {
				if (success(['search_query'])) data.web.searches++;
				if (success(['open', 'click'])) data.web.opens++;
				if (success(['find'])) data.web.finds++;
				if (success(['image_query'])) data.images.searches++;
				if (failed(['search_query', 'open', 'click', 'find', 'screenshot'])) data.web.failedCalls++;
				if (failed(['image_query'])) data.images.failedCalls++;
			}
			if (call.name === 'image.view') {
				if (succeeded) data.images.views++;
				else data.images.failedCalls++;
			}
			if (!succeeded) continue;
			if (
				call.name === 'view_image' &&
				typeof args.path === 'string' &&
				args.path.trim() &&
				args.path.length <= 4096 &&
				call.result?.content.some((part) => part.type === 'image')
			) {
				const path = args.path.trim();
				const item = source(
					`local-image:${path}`,
					'local-image',
					path.split(/[\\/]/).pop() || 'Local image',
				);
				if (item) {
					item.path = path;
					item.viewed++;
				}
			}
			const research = call.result?.research;
			const images = research?.images?.slice(0, 128) ?? [];
			const imageIds = new Set(
				images
					.filter((image) => researchUrl(image.url) && researchUrl(image.sourceUrl))
					.map((image) => image.id),
			);
			function actions(
				item: ConversationSource,
				id: string,
				url: string,
				imageUrl?: string,
				accessed?: number,
			) {
				const matches = (refs: Set<string>) =>
					refs.has(id) || refs.has(url) || !!(imageUrl && refs.has(imageUrl));
				const search =
					matches(proof.searched) ||
					(!operations?.length &&
						has(['search_query', 'image_query']) &&
						!has(['open', 'click', 'find', 'screenshot']));
				const read =
					matches(proof.opened) ||
					(!operations?.length &&
						entries(args.open).some(
							(entry) => entry.ref_id === id || researchUrl(entry.ref_id) === url,
						) &&
						typeof accessed === 'number' &&
						Number.isFinite(accessed) &&
						accessed > 0);
				if (search) item.searched++;
				if (read) item.opened++;
				if (typeof accessed === 'number' && Number.isFinite(accessed) && accessed > 0)
					item.read = true;
				if (call.name === 'image.view') item.viewed++;
			}
			const added = new Set<string>();
			for (const image of images) {
				const imageUrl = researchUrl(image.url),
					url = researchUrl(image.sourceUrl);
				if (!imageUrl || !url || typeof image.id !== 'string') continue;
				const item = source(
					`image:${imageUrl}`,
					'image',
					title(image.title, researchDomain(url)),
					url,
				);
				if (!item || added.has(item.id)) continue;
				added.add(item.id);
				item.title = title(image.title, item.title);
				item.imageUrl = imageUrl;
				const metadata = research?.sources?.find((row) => row.id === image.id);
				actions(item, image.id, url, imageUrl, metadata?.accessedAt);
			}
			for (const row of research?.sources?.slice(0, 128) ?? []) {
				const url = researchUrl(row.url);
				if (!url || typeof row.id !== 'string' || imageIds.has(row.id)) continue;
				const item = source(`web:${url}`, 'web', title(row.title, researchDomain(url)), url);
				if (!item || added.has(item.id)) continue;
				added.add(item.id);
				item.title = title(row.title, item.title);
				actions(item, row.id, url, undefined, row.accessedAt);
			}
		}
		if (examinedCalls > MAX_CALLS) break;
	}
	data.items = [...sources.values()];
	data.hasSources =
		data.items.length > 0 ||
		[...Object.values(data.web), ...Object.values(data.images)].some((count) => count > 0);
	return data;
}

/** Uploaded pixels are previewed locally; research image URLs are never loaded by this panel. */
export function sourceImagePreview(attachment: Attachment): string | undefined {
	if (attachment.dataUrl.length > 48 * 1024 * 1024) return;
	const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif|avif));base64,/i.exec(attachment.dataUrl);
	if (match && attachment.type.toLowerCase() === match[1].toLowerCase()) return attachment.dataUrl;
}

export function sourceProvenance(item: ConversationSource): string[] {
	const labels: string[] = [];
	if (item.provided) labels.push('Provided in conversation');
	if (item.searched)
		labels.push(`Searched ${item.searched} ${item.searched === 1 ? 'time' : 'times'}`);
	if (item.opened) labels.push(`Opened ${item.opened} ${item.opened === 1 ? 'time' : 'times'}`);
	else if (item.read) labels.push('Read during conversation');
	if (item.viewed) labels.push(`Viewed ${item.viewed} ${item.viewed === 1 ? 'time' : 'times'}`);
	if (!labels.length) labels.push('Found during conversation');
	return labels;
}
