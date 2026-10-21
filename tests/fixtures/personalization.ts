import type { PersonalizationSettings } from '../../src/personalization-types';

export function personalizationFixture(): PersonalizationSettings {
	return {
		chat: {
			personality: 'friendly',
			warmth: 'more',
			enthusiasm: 'less',
			responseLength: 'default',
			formatting: 'more',
			emojis: 'less',
			customInstructions: 'Explain using concise examples.',
		},
		code: {
			personality: 'professional',
			warmth: 'less',
			enthusiasm: 'default',
			responseLength: 'more',
			formatting: 'less',
			emojis: 'default',
			customInstructions: 'Prefer TypeScript and validate each change.',
		},
	};
}
