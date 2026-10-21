export type ModerationLevel = 'low' | 'medium' | 'high';
export type ModerationMediaKind = 'image' | 'video';
export interface ModerationEvaluator {
	connectionId: string;
	model: string;
	thinkingMode?: string;
	/** Legacy saved setting; ignored. Video samples use the connection's normal image-input API. */
	videoApi?: 'chat/completions' | 'chat' | 'responses';
}
export interface ModerationMediaSettings extends ModerationEvaluator {
	enabled: boolean;
	level: ModerationLevel;
}
export interface ModerationSettings {
	image: ModerationMediaSettings;
	video: ModerationMediaSettings;
}
/** Configuration written before image/video policies became independent. */
export interface LegacyModerationSettings {
	enabled: boolean;
	level: ModerationLevel;
	image: ModerationEvaluator;
	video: ModerationEvaluator;
}
export type ModerationSettingsInput = ModerationSettings | LegacyModerationSettings;
export const MODERATION_CATEGORIES = [
	'ncii',
	'sexual_minors',
	'violent_minors',
	'sexual_content',
	'artistic_nudity',
	'nudity',
	'gore',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];
export type ModerationLabels = Record<ModerationCategory, boolean>;
/** Contextual input classification only; output classifiers inspect media in isolation. */
export const IMAGE_EDIT_MODERATION_CATEGORIES = [
	...MODERATION_CATEGORIES,
	'input_contains_person',
	'edit_sexual_content',
	'edit_nudity',
] as const;
export type ImageEditModerationCategory = (typeof IMAGE_EDIT_MODERATION_CATEGORIES)[number];
export type ImageEditModerationLabels = Record<ImageEditModerationCategory, boolean>;
export type ModerationEvaluationScope = 'standard' | 'image-edit';
