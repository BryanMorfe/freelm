import type { ToolCallRecord } from '../agent-types';
import type { ResearchImage, ResearchSource } from '../research-types';

/** Rendering may use public links only; never trust source metadata as HTML. */
export function researchUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value || value.length > 2048) return;
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
		const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
		if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
			return;
		// Host retrieval enforces DNS and redirects; reject obvious private literals here too.
		if (/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname))
			return;
		if (hostname.startsWith('[') && !/^\[?[23][\da-f]{3}:/i.test(hostname)) return;
		return url.href;
	} catch {
		return;
	}
}

export function researchDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/** A message may search and read the same source repeatedly; show one enriched entry. */
export function collectResearchResults(calls: ToolCallRecord[] = []): {
	sources: ResearchSource[];
	images: ResearchImage[];
} {
	const sources = new Map<string, ResearchSource>();
	const images = new Map<string, ResearchImage>();
	for (const call of calls) {
		if (call.status !== 'completed' || call.result?.isError) continue;
		for (const source of call.result?.research?.sources?.slice(0, 128) ?? []) {
			const url = researchUrl(source.url);
			if (
				!url ||
				typeof source.id !== 'string' ||
				typeof source.title !== 'string' ||
				!source.title.trim()
			)
				continue;
			const existing = sources.get(url);
			if (sources.size >= 64 && !existing) continue;
			sources.set(url, { ...existing, ...source, url, title: source.title.slice(0, 300) });
		}
		for (const image of call.result?.research?.images?.slice(0, 128) ?? []) {
			const url = researchUrl(image.url);
			const sourceUrl = researchUrl(image.sourceUrl);
			if (!url || !sourceUrl || typeof image.id !== 'string' || typeof image.title !== 'string')
				continue;
			const existing = images.get(url);
			if (images.size >= 64 && !existing) continue;
			const preview =
				typeof image.previewDataUrl === 'string' &&
				image.previewDataUrl.length <= 200_000 &&
				/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image.previewDataUrl)
					? image.previewDataUrl
					: undefined;
			images.set(url, {
				...existing,
				...image,
				url,
				sourceUrl,
				title: image.title.slice(0, 300),
				thumbnailUrl: researchUrl(image.thumbnailUrl),
				previewDataUrl: preview ?? existing?.previewDataUrl,
			});
		}
	}
	return { sources: [...sources.values()], images: [...images.values()] };
}
