import type { ComposerReference, ComposerSuggestion } from '../composer-types';

export const COMPOSER_MENTION_DOCUMENT_LIMIT = 1_000_000;
export const COMPOSER_REFERENCE_LIMIT = 30;
const MENTION = /\[((?:\\.|[^\]\\\n])*)\]\((freelm-(skill|file|folder|app)):([^\s)]{1,12000})\)/g;
export function validMentionIcon(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 6000 &&
		/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)
	);
}
export interface ComposerMentionRange {
	from: number;
	to: number;
	reference: ComposerReference;
}

/** These identifiers are references, never permission grants. The host revalidates them. */
export function createComposerMention(item: ComposerSuggestion): ComposerReference {
	const payload = encodeURIComponent(
		JSON.stringify({
			id: item.id,
			label: item.label,
			path: item.path,
			...(item.kind === 'app' && validMentionIcon(item.icon) ? { icon: item.icon } : {}),
		}),
	).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
	const label = item.label.replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');
	return {
		kind: item.kind,
		id: item.id,
		label: item.label,
		path: item.path,
		...(item.kind === 'app' && validMentionIcon(item.icon) ? { icon: item.icon } : {}),
		token: `[${label}](freelm-${item.kind}:${payload})`,
	};
}

export function scanComposerMentions(text: string, max = 1024): ComposerMentionRange[] {
	if (text.length > COMPOSER_MENTION_DOCUMENT_LIMIT) return [];
	const ranges: ComposerMentionRange[] = [];
	const matcher = new RegExp(MENTION.source, 'g');
	for (const match of text.matchAll(matcher)) {
		if (ranges.length >= Math.min(1024, Math.max(0, max))) break;
		try {
			const data: unknown = JSON.parse(decodeURIComponent(match[4]));
			if (!data || typeof data !== 'object') continue;
			const { id, label, path, icon } = data as Record<string, unknown>;
			if (
				![id, label, path].every(
					(value) =>
						typeof value === 'string' &&
						value.length > 0 &&
						value.length <= 4096 &&
						!/[\x00-\x1f]/.test(value),
				)
			)
				continue;
			ranges.push({
				from: match.index!,
				to: match.index! + match[0].length,
				reference: {
					kind: match[3] as ComposerReference['kind'],
					id: id as string,
					label: label as string,
					path: path as string,
					...(match[3] === 'app' && validMentionIcon(icon) ? { icon } : {}),
					token: match[0],
				},
			});
		} catch {
			/* Malformed pasted URLs remain ordinary text. */
		}
	}
	return ranges;
}

export function composerVisibleText(text: string): string {
	let result = '',
		position = 0;
	for (const range of scanComposerMentions(text)) {
		result += text.slice(position, range.from) + range.reference.label;
		position = range.to;
	}
	return result + text.slice(position);
}
