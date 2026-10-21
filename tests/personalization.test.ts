import { describe, expect, it } from 'vitest';
import {
	defaultPersonalization,
	personalizationProfile,
	personalityOptions,
	personalityPrompt,
} from '../src/lib/personalization';
import { PERSONALITIES, MAX_CUSTOM_INSTRUCTIONS } from '../src/personalization-types';
import type { AppState } from '../src/types';

describe('FreeLM personalization guidance', () => {
	it('creates independent Chat, Code and workspace defaults', () => {
		const first = defaultPersonalization();
		const second = defaultPersonalization();
		expect(first.chat).not.toBe(first.code);
		expect(first.chat).not.toBe(second.chat);
		expect(first.code).not.toBe(second.code);
		first.chat.personality = 'friendly';
		first.code.customInstructions = 'Use focused checks.';
		expect(second.chat.personality).toBe('default');
		expect(first.code.personality).toBe('default');
		expect(second.code.customInstructions).toBe('');
	});

	it('supplies balanced defaults for a legacy state without adding persisted fields', () => {
		const state: Pick<AppState, 'personalization'> = {};
		const profile = personalizationProfile(state, 'chat');
		expect(profile).toEqual(defaultPersonalization().chat);
		profile.warmth = 'more';
		expect(personalizationProfile(state, 'chat').warmth).toBe('default');
		expect(state).toEqual({});
	});

	it('reads the selected mode without sharing objects or changing either profile', () => {
		const personalization = defaultPersonalization();
		personalization.chat = {
			...personalization.chat,
			personality: 'friendly',
			warmth: 'more',
			customInstructions: 'CHAT_ONLY',
		};
		personalization.code = {
			...personalization.code,
			personality: 'efficient',
			formatting: 'less',
			customInstructions: 'CODE_ONLY',
		};
		const before = structuredClone(personalization);
		const chat = personalizationProfile({ personalization }, 'chat');
		const code = personalizationProfile({ personalization }, 'code');
		expect(chat).toEqual(personalization.chat);
		expect(code).toEqual(personalization.code);
		chat.customInstructions = 'A detached edit';
		code.emojis = 'more';
		expect(personalization).toEqual(before);
	});

	it('recovers missing or unrecognized presentation values without merging modes', () => {
		const personalization = {
			chat: {
				personality: 'unknown',
				warmth: 'more',
				enthusiasm: 'unknown',
				customInstructions: 'A retained preference.',
			},
		} as unknown as NonNullable<AppState['personalization']>;
		const before = structuredClone(personalization);
		expect(personalizationProfile({ personalization }, 'chat')).toEqual({
			...defaultPersonalization().chat,
			warmth: 'more',
			customInstructions: 'A retained preference.',
		});
		expect(personalizationProfile({ personalization }, 'code')).toEqual(
			defaultPersonalization().code,
		);
		expect(personalization).toEqual(before);
	});

	it('provides a unique labeled option for each supported personality', () => {
		expect(personalityOptions.map((option) => option.value)).toEqual([...PERSONALITIES]);
		expect(new Set(personalityOptions.map((option) => option.label)).size).toBe(
			PERSONALITIES.length,
		);
		for (const option of personalityOptions) {
			expect(option.label.trim()).not.toBe('');
			expect(option.description.trim()).not.toBe('');
		}
	});

	it('defines honest identities and mode-specific capabilities without granting tool permissions', () => {
		const chat = personalityPrompt({}, 'chat');
		const code = personalityPrompt({}, 'code');
		expect(chat).toContain('You are an AI assistant in FreeLM.');
		expect(chat).toContain('cannot read local files or execute local commands');
		expect(code).toContain('You are an AI coding assistant in FreeLM.');
		expect(code).toContain('local files and commands are available only through enabled tools');
		for (const prompt of [chat, code]) {
			expect(prompt).toContain('Do not invent or impersonate a model provider');
			expect(prompt).toContain('Report tool outcomes accurately');
			expect(prompt).toContain('never permissions, enabled tools or required task behavior');
			expect(prompt).toContain('Adapt to the user’s explicit requests');
			expect(prompt).not.toContain('web.run');
			expect(prompt).not.toContain('memory.search');
		}
	});

	it('keeps correctness, permission and explicit-user-request rules for every preset', () => {
		for (const option of personalityOptions) {
			const personalization = defaultPersonalization();
			personalization.chat.personality = option.value;
			const prompt = personalityPrompt({ personalization }, 'chat');
			expect(prompt).toContain(`Personality: ${option.label}.`);
			expect(prompt).toContain('Prioritize correctness and the user’s goals');
			expect(prompt).toContain('never permissions, enabled tools or required task behavior');
			expect(prompt).toContain('requests for a different tone or format');
		}
	});

	it('makes all selected characteristic levels explicit while leaving the other mode unchanged', () => {
		const personalization = defaultPersonalization();
		const baselineCode = personalityPrompt({ personalization }, 'code');
		for (const level of ['less', 'default', 'more'] as const) {
			personalization.chat = {
				...personalization.chat,
				warmth: level,
				enthusiasm: level,
				responseLength: level,
				formatting: level,
				emojis: level,
			};
			const prompt = personalityPrompt({ personalization }, 'chat');
			for (const characteristic of [
				'Warmth',
				'Enthusiasm',
				'Response length',
				'Formatting',
				'Emojis',
			])
				expect(prompt).toContain(`${characteristic} (${level}):`);
			expect(personalityPrompt({ personalization }, 'code')).toBe(baselineCode);
		}
	});

	it('less formatting and emojis retain useful technical and explicitly requested content', () => {
		const personalization = defaultPersonalization();
		personalization.chat.formatting = 'less';
		personalization.chat.emojis = 'less';
		const prompt = personalityPrompt({ personalization }, 'chat');
		expect(prompt).toContain('Avoid decorative headings');
		expect(prompt).toContain(
			'Preserve useful code blocks, equations, tables and explicitly requested formats',
		);
		expect(prompt).toContain(
			'Preserve exact quotes, code, data and any emojis the user explicitly requests',
		);
	});

	it('warm and cynical styles remain respectful instead of flattering or belittling', () => {
		const personalization = defaultPersonalization();
		personalization.chat.warmth = 'more';
		personalization.chat.personality = 'friendly';
		expect(personalityPrompt({ personalization }, 'chat')).toContain(
			'Avoid flattery, ingratiating praise',
		);
		personalization.code.personality = 'cynical';
		expect(personalityPrompt({ personalization }, 'code')).toContain(
			'Never belittle the user, mock vulnerability or assume bad faith',
		);
		expect(personalityPrompt({ personalization }, 'code')).toContain(
			'serious situations compassionate',
		);
	});

	it('appends exact custom instructions only for the selected mode and preserves the valid size boundary', () => {
		const personalization = defaultPersonalization();
		const prefix = '  Preserve 🦄 and code literally.\n';
		const custom = prefix + 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS - prefix.length);
		expect(custom.length).toBe(MAX_CUSTOM_INSTRUCTIONS);
		personalization.chat.customInstructions = custom;
		personalization.code.customInstructions = 'CODE_CUSTOM';
		const before = structuredClone(personalization);
		const chat = personalityPrompt({ personalization }, 'chat');
		const code = personalityPrompt({ personalization }, 'code');
		expect(chat.endsWith(`Custom instructions for Chat:\n${custom}`)).toBe(true);
		expect(chat).not.toContain('CODE_CUSTOM');
		expect(code.endsWith('Custom instructions for Code:\nCODE_CUSTOM')).toBe(true);
		expect(code).not.toContain(custom);
		expect(personalization).toEqual(before);
	});

	it('omits an empty custom-instructions section without changing the stored whitespace', () => {
		const personalization = defaultPersonalization();
		personalization.chat.customInstructions = ' \n\t ';
		expect(personalityPrompt({ personalization }, 'chat')).not.toContain('Custom instructions for');
		expect(personalization.chat.customInstructions).toBe(' \n\t ');
	});
});
