import type { AppState, Attachment, Message } from '../types';
import { conversationNodes } from './conversation-tree';
import { decodeAttachmentText, textAttachment } from './text-attachments';

export const MAX_BOT_ATTACHMENTS = 6;
const MAX_ASSET_CHARS = Math.ceil((32 * 1024 * 1024) / 3) * 4 + 256;
const MAX_TOTAL_CHARS = Math.ceil((64 * 1024 * 1024) / 3) * 4;
const PREFIX = 'thread-asset:';
type Location = [
	hostId: string,
	threadId: string,
	messageId: string,
	toolCallId: string | null,
	index: number,
];

export interface BotThreadAttachment {
	ref: string;
	name: string;
	type: string;
	source: 'attachment' | 'tool';
	forwardable: boolean;
}

function storedAssets(message: Message) {
	const attached = (message.attachments ?? []).map((attachment, index) => ({
		attachment,
		toolCallId: null as string | null,
		index,
	}));
	const outputs = (message.toolCalls ?? [])
		.filter((call) => call.status === 'completed' && !call.result?.isError)
		.flatMap((call) =>
			(call.result?.content ?? []).flatMap((part, index) => {
				if (part.type !== 'image' && part.type !== 'file') return [];
				// Computer screenshots are transient observations, not user-created assets.
				if (part.type === 'image' && part.purpose === 'computer') return [];
				const type =
					part.type === 'file'
						? part.mimeType
						: (/^data:(image\/[^;,]+)[;,]/i.exec(part.dataUrl)?.[1] ?? 'image/png');
				return [
					{
						attachment: { name: part.name || `Image ${index + 1}`, type, dataUrl: part.dataUrl },
						toolCallId: call.id,
						index,
					},
				];
			}),
		);
	return [...attached, ...outputs];
}

function supported(attachment: Attachment): boolean {
	if (!attachment.dataUrl || attachment.dataUrl.length > MAX_ASSET_CHARS) return false;
	if (/^image\/(png|jpe?g|webp|gif)$/i.test(attachment.type))
		return new RegExp(`^data:${attachment.type};base64,[a-z\\d+/=\\r\\n]+$`, 'i').test(
			attachment.dataUrl,
		);
	return (
		(/^text\//.test(attachment.type) || attachment.type === 'application/json') &&
		/^data:(?:text\/[^;,]+|application\/json)(?:;charset=[^;,]+)?(?:;base64)?,/.test(
			attachment.dataUrl,
		)
	);
}

/** Return addressing metadata only: never pixels, file paths, URLs, or provider credentials. */
export function botThreadAttachments(
	hostId: string | undefined,
	threadId: string,
	message: Message,
	limit: number,
): { attachments: BotThreadAttachment[]; omittedAttachmentCount: number } {
	const assets = storedAssets(message);
	const selected = hostId ? assets.slice(0, limit) : [];
	return {
		attachments: selected.map(({ attachment, toolCallId, index }) => ({
			ref:
				PREFIX +
				encodeURIComponent(JSON.stringify([hostId, threadId, message.id, toolCallId, index])),
			name: attachment.name.slice(0, 256),
			type: attachment.type.slice(0, 128),
			source: toolCallId === null ? 'attachment' : 'tool',
			forwardable: supported(attachment),
		})),
		omittedAttachmentCount: assets.length - selected.length,
	};
}

function location(value: unknown): Location {
	if (typeof value !== 'string' || value.length > 4096 || !value.startsWith(PREFIX))
		throw new Error(
			'Use attachmentRefs returned by threads_read, not paths, URLs, or invented IDs.',
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(value.slice(PREFIX.length)));
	} catch {
		throw new Error('Invalid thread attachment reference. Read the source thread again.');
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 5 ||
		!parsed
			.slice(0, 3)
			.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 256) ||
		!(
			parsed[3] === null ||
			(typeof parsed[3] === 'string' && parsed[3].length > 0 && parsed[3].length <= 256)
		) ||
		!Number.isInteger(parsed[4]) ||
		parsed[4] < 0 ||
		parsed[4] > 100_000
	)
		throw new Error('Invalid thread attachment reference. Read the source thread again.');
	return parsed as Location;
}

/** Resolve against the selected host's current state, inside its serialized mutation. */
export function resolveBotThreadAttachments(
	value: unknown,
	state: AppState,
	hostId: string | undefined,
): Attachment[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BOT_ATTACHMENTS)
		throw new Error(
			`attachmentRefs must contain 1–${MAX_BOT_ATTACHMENTS} references from threads_read.`,
		);
	if (!hostId)
		throw new Error(
			'Attachment forwarding is unavailable until this computer’s identity is loaded.',
		);
	if (new Set(value).size !== value.length)
		throw new Error('Attachment references must be unique.');
	let total = 0;
	return value.map((ref) => {
		const [sourceHost, threadId, messageId, toolCallId, index] = location(ref);
		if (sourceHost !== hostId)
			throw new Error(
				'Attachments can only be forwarded between threads on the same computer. Read the source on the destination host.',
			);
		const thread = state.threads.find((item) => item.id === threadId && !item.temporary);
		const message = thread && conversationNodes(thread).find((item) => item.id === messageId);
		const stored =
			message &&
			storedAssets(message).find((item) => item.toolCallId === toolCallId && item.index === index);
		if (!stored)
			throw new Error(
				'This thread attachment is no longer available. Read the source thread again.',
			);
		let attachment = stored.attachment;
		if (!supported(attachment))
			throw new Error(
				'Only stored image and text attachments up to 32 MB can be forwarded to Chat or Code.',
			);
		if (attachment.type === 'application/json') {
			const text = decodeAttachmentText(attachment);
			if (text === undefined) throw new Error('Could not decode this document.');
			attachment = textAttachment(attachment.name, text);
		} else if (/^text\//.test(attachment.type)) {
			// Validate before committing a queued input that the provider cannot decode.
			decodeAttachmentText(attachment);
		}
		total += attachment.dataUrl.length;
		if (total > MAX_TOTAL_CHARS)
			throw new Error('Forwarded attachments exceed the 64 MB total limit.');
		return { ...attachment };
	});
}
