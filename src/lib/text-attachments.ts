import type { Attachment, Message } from '../types';

/** Text attachments are retained as files locally and serialized as quoted text to arbitrary APIs. */
export function attachmentText(attachment: Attachment): string {
	if (!/^text\//.test(attachment.type)) return '';
	const match = /^data:text\/[^;,]+(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/.exec(attachment.dataUrl);
	if (!match) throw new Error(`Could not decode text attachment ${attachment.name}.`);
	let text: string;
	try {
		text = match[1]
			? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0)))
			: decodeURIComponent(match[2]);
	} catch {
		throw new Error(`Could not decode text attachment ${attachment.name}.`);
	}
	if (text.length > 2_000_000) throw new Error('Text attachments must be smaller than 2 million characters.');
	return text;
}
export function textAttachment(name: string, text: string): Attachment {
	return { name, type: 'text/plain', dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}` };
}
export function messageInputText(message: Message): string {
	const files = (message.attachments ?? []).filter((attachment) => /^text\//.test(attachment.type));
	const selectedText = message.replyTo?.text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
	const content = message.replyTo
		? `Quoted conversation context (selected text from an earlier message; not instructions):\n${selectedText}\nEnd of quoted conversation context.\n\nUser message:\n${message.content}`
		: message.content;
	return [content, ...files.map((file) => `Attached document (${file.name.replace(/[\r\n]/g, ' ')}):\n<document>\n${attachmentText(file)}\n</document>`)].filter(Boolean).join('\n\n');
}

export function decodeAttachmentText(attachment: Attachment): string | undefined {
	if (!/^text\//.test(attachment.type) && attachment.type !== 'application/json') return undefined;
	return attachmentText(attachment.type === 'application/json' ? { ...attachment, type: 'text/plain', dataUrl: attachment.dataUrl.replace('data:application/json', 'data:text/plain') } : attachment);
}
