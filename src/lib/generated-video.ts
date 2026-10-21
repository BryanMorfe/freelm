import type { ToolContent } from '../agent-types';

// Matches the existing 32 MiB generated-media download/moderation bound, including base64.
export const MAX_GENERATED_VIDEO_CHARS = 45_000_000;

export function isVideoFile(
	part: ToolContent,
): part is Extract<ToolContent, { type: 'file' }> & { mimeType: `video/${string}` } {
	return (
		part.type === 'file' &&
		/^video\/[a-z0-9.+-]+$/i.test(part.mimeType) &&
		part.dataUrl.startsWith(`data:${part.mimeType};base64,`)
	);
}
