/** Existing 720p playground default, snapped to the required multiple of 32.
 * Shared with tools when neither the caller nor saved settings supplies a size. */
export const DEFAULT_VIDEO_SIZE = '1280x736';

/** Snap explicit pixel dimensions; leave blank/provider-specific values unchanged. */
export function normalizeVideoResolution(value: string): string {
	const trimmed = value.trim();
	const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(trimmed);
	if (!dimensions) return trimmed;
	const pixels = dimensions.slice(1).map(Number);
	if (pixels.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0))
		return trimmed;
	const rounded = pixels.map((dimension) => Math.max(32, Math.round(dimension / 32) * 32));
	return rounded.every(Number.isSafeInteger) ? rounded.join('x') : trimmed;
}
