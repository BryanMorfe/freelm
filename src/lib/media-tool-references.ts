import type { ToolHostRequest } from '../agent-types';
import type { Attachment } from '../types';

/** Send only the references this call requests; unrelated history must not affect generation. */
export function selectMediaToolReferences(
	name: string,
	args: Record<string, unknown>,
	recentImages: readonly Attachment[],
): Pick<ToolHostRequest, 'recentImages'> {
	if (name !== 'image_gen.imagegen' && name !== 'video_gen.videogen') return {};
	// The host owns argument validation, including mutually exclusive reference mechanisms.
	if (args.referenced_image_paths !== undefined || args.num_last_images_to_include === undefined)
		return {};
	const count =
		name === 'image_gen.imagegen'
			? Number(args.num_last_images_to_include)
			: args.num_last_images_to_include;
	const maximum = name === 'image_gen.imagegen' ? 5 : 1;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > maximum)
		return {};
	// Keep the exact requested suffix, even if a selected reference is invalid or missing.
	// Filtering or padding here could silently change the image being edited or animated.
	return { recentImages: recentImages.slice(-count) };
}
