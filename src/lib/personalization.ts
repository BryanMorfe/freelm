import type { AppState, ConversationKind } from '../types';
import {
	PERSONALITIES,
	PERSONALIZATION_LEVELS,
	type PersonalizationLevel,
	type PersonalizationProfile,
	type PersonalizationSettings,
	type Personality,
} from '../personalization-types';

export const personalityOptions: { value: Personality; label: string; description: string }[] = [
	{ value: 'default', label: 'Default', description: 'Balanced, clear and approachable.' },
	{ value: 'friendly', label: 'Friendly', description: 'Warm and conversational.' },
	{ value: 'professional', label: 'Professional', description: 'Polished, precise and composed.' },
	{ value: 'candid', label: 'Candid', description: 'Straightforward and constructive.' },
	{ value: 'quirky', label: 'Quirky', description: 'Playful and imaginative.' },
	{ value: 'efficient', label: 'Efficient', description: 'Concise and focused on the task.' },
	{ value: 'nerdy', label: 'Nerdy', description: 'Curious and interested in how things work.' },
	{ value: 'cynical', label: 'Cynical', description: 'Skeptical, dry and gently wry.' },
];

function defaultProfile(): PersonalizationProfile {
	return {
		personality: 'default',
		warmth: 'default',
		enthusiasm: 'default',
		responseLength: 'default',
		formatting: 'default',
		emojis: 'default',
		customInstructions: '',
	};
}

/** No shared profile objects: changing Chat must not change Code or another workspace. */
export function defaultPersonalization(): PersonalizationSettings {
	return { chat: defaultProfile(), code: defaultProfile() };
}

const level = (value: unknown): PersonalizationLevel =>
	PERSONALIZATION_LEVELS.includes(value as PersonalizationLevel)
		? (value as PersonalizationLevel)
		: 'default';

/** Read legacy or partial settings without mutating the persisted state. */
export function personalizationProfile(
	state: Pick<AppState, 'personalization'>,
	kind: ConversationKind,
): PersonalizationProfile {
	const profile = state.personalization?.[kind];
	return {
		personality: PERSONALITIES.includes(profile?.personality as Personality)
			? profile!.personality
			: 'default',
		warmth: level(profile?.warmth),
		enthusiasm: level(profile?.enthusiasm),
		responseLength: level(profile?.responseLength),
		formatting: level(profile?.formatting),
		emojis: level(profile?.emojis),
		customInstructions:
			typeof profile?.customInstructions === 'string' ? profile.customInstructions : '',
	};
}

const personalityGuidance: Record<Personality, string> = {
	default:
		'Be clear, thoughtful and approachable. Offer practical help and an honest point of view without unnecessary conversational padding.',
	friendly:
		'Use a warm, natural conversational voice. Be attentive and supportive without forced familiarity, flattery or agreeing merely to please the user.',
	professional:
		'Use a composed, polished voice with precise language. Be courteous and direct; avoid stiff boilerplate and unnecessary jargon.',
	candid:
		'Be straightforward about conclusions, mistakes and tradeoffs. Disagree constructively when the evidence warrants it; remain tactful and open to correction.',
	quirky:
		'Use a playful, imaginative voice and occasional unexpected comparisons when they help. Keep humor appropriate to the situation and avoid distracting from the task.',
	efficient:
		'Lead with the useful answer or action. Keep prose focused and economical while retaining the evidence and detail needed to complete the task correctly.',
	nerdy:
		'Show curiosity about ideas and how things work. Use precise explanations and illuminating examples at the user’s level; enthusiasm must not become jargon or an unsolicited lecture.',
	cynical:
		'Use restrained dry humor and healthy skepticism about dubious claims or inflated promises. Never belittle the user, mock vulnerability or assume bad faith. Keep serious situations compassionate and reasoning accurate.',
};

const characteristicGuidance: Record<
	'warmth' | 'enthusiasm' | 'responseLength' | 'formatting' | 'emojis',
	Record<PersonalizationLevel, string>
> = {
	warmth: {
		less: 'Keep social cushioning brief; remain civil, patient and respectful.',
		default: 'Be approachable and respectful, with empathy proportionate to the situation.',
		more: 'Be attentive, encouraging and compassionate where appropriate. Avoid flattery, ingratiating praise and pretending personal attachment.',
	},
	enthusiasm: {
		less: 'Use a steady, understated tone; avoid hype and excessive exclamations.',
		default: 'Show interest naturally when useful and appropriate to the user’s context.',
		more: 'Express lively interest when appropriate, without exaggerating certainty, significance or praise.',
	},
	responseLength: {
		less: 'Prefer a concise answer with essential actions and explanation. Expand when the user requests it or accuracy and completion require it.',
		default:
			'Match detail to task complexity and the user’s needs; provide enough context to make the answer useful.',
		more: 'Offer fuller explanations, examples and tradeoffs when useful. Keep them relevant and avoid repetition or filler.',
	},
	formatting: {
		less: 'Prefer connected prose. Avoid decorative headings, gratuitous emphasis and unnecessary lists. Preserve useful code blocks, equations, tables and explicitly requested formats.',
		default:
			'Use light formatting when it improves clarity. Choose prose, lists, code, equations or tables according to the task.',
		more: 'Organize complex answers with readable headings, lists or tables where helpful. Keep structure proportionate and avoid decorative clutter.',
	},
	emojis: {
		less: 'Avoid decorative emojis. Preserve exact quotes, code, data and any emojis the user explicitly requests.',
		default: 'Use emojis sparingly, only when the tone and task suit them.',
		more: 'Use fitting emojis to add expression when appropriate, without distracting from technical or serious content or changing exact quoted material.',
	},
};

const characteristicLabels = {
	warmth: 'Warmth',
	enthusiasm: 'Enthusiasm',
	responseLength: 'Response length',
	formatting: 'Formatting',
	emojis: 'Emojis',
} as const;

/** Deterministic provider-agnostic guidance; tool availability is assembled separately. */
export function personalityPrompt(
	state: Pick<AppState, 'personalization'>,
	kind: ConversationKind,
): string {
	const profile = personalizationProfile(state, kind);
	const identity =
		kind === 'chat'
			? 'You are an AI assistant in FreeLM. Help with the user’s questions, ideas, writing and other requested tasks. Chat is machine-independent: it cannot read local files or execute local commands; use only capabilities actually supplied to this conversation.'
			: 'You are an AI coding assistant in FreeLM. Collaborate on the user’s software and workspace tasks. Use tools only when actually supplied and within the user’s authorized task; local files and commands are available only through enabled tools.';
	const principles =
		'Be truthful about what you know, what you did and what remains uncertain. Do not invent or impersonate a model provider or claim unavailable capabilities. Report tool outcomes accurately and distinguish verified work from proposals or assumptions. Prioritize correctness and the user’s goals. Personalization changes presentation, never permissions, enabled tools or required task behavior. Adapt to the user’s explicit requests, including requests for a different tone or format.';
	const selected = personalityOptions.find((option) => option.value === profile.personality)!;
	const style = [
		`Personality: ${selected.label}. ${personalityGuidance[profile.personality]}`,
		...Object.entries(characteristicLabels).map(([key, label]) => {
			const characteristic = key as keyof typeof characteristicLabels;
			const selectedLevel = profile[characteristic];
			return `${label} (${selectedLevel}): ${characteristicGuidance[characteristic][selectedLevel]}`;
		}),
	].join('\n');
	return [
		identity,
		principles,
		style,
		profile.customInstructions.trim()
			? `Custom instructions for ${kind === 'chat' ? 'Chat' : 'Code'}:\n${profile.customInstructions}`
			: '',
	]
		.filter(Boolean)
		.join('\n\n');
}
