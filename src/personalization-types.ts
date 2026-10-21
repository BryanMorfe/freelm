export const PERSONALITIES = [
	'default',
	'friendly',
	'professional',
	'candid',
	'quirky',
	'efficient',
	'nerdy',
	'cynical',
] as const;
export const PERSONALIZATION_LEVELS = ['less', 'default', 'more'] as const;
export const MAX_CUSTOM_INSTRUCTIONS = 10_000;

export type Personality = (typeof PERSONALITIES)[number];
export type PersonalizationLevel = (typeof PERSONALIZATION_LEVELS)[number];

export interface PersonalizationProfile {
	personality: Personality;
	warmth: PersonalizationLevel;
	enthusiasm: PersonalizationLevel;
	responseLength: PersonalizationLevel;
	formatting: PersonalizationLevel;
	emojis: PersonalizationLevel;
	customInstructions: string;
}

export interface PersonalizationSettings {
	chat: PersonalizationProfile;
	code: PersonalizationProfile;
}
