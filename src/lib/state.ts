import { composerVisibleText } from './composer-mention-codec';
import type { AppState, Connection, Message } from '../types';
import { defaultThinkingPresets } from './catalog';
import { migrateConversationKinds } from './conversation-kind';
import { defaultAppearance } from './appearance';
import { defaultCodeCompactionSettings, migrateCodeCompactionSettings } from './code-compaction';
import { recoverCodeQueueFailures } from './code-queue';
import { defaultModerationSettings } from './moderation';

export const newConnection = (): Connection => ({
	id: crypto.randomUUID(),
	name: 'Local API',
	baseUrl: 'http://localhost:8000/v1',
	apiKey: '',
	chatApi: 'responses',
	models: { chat: '', images: '', videos: '', speech: '', transcription: '' },
	discoveredModels: [],
});
export function initialState(): AppState {
	const connection = newConnection();
	return {
		version: 1,
		connections: [connection],
		activeConnectionId: connection.id,
		threads: [],
		projects: [],
		generations: [],
		theme: 'dark',
		appearance: defaultAppearance(),
		debugMode: false,
		systemPrompt: '',
		thinkingPresets: defaultThinkingPresets(),
		codeCompaction: defaultCodeCompactionSettings(),
		moderation: defaultModerationSettings(),
	};
}
export function recoverState(
	state: AppState,
	options: { codeCompactionSupported?: boolean; activeThreadIds?: readonly string[] } = {},
): AppState {
	state = migrateConversationKinds(state);
	if (options.codeCompactionSupported !== false) state = migrateCodeCompactionSettings(state);
	const preserve = <T>(values: T[], recover: (value: T) => T): T[] => {
		const next = values.map(recover);
		return next.some((value, index) => value !== values[index]) ? next : values;
	};
	const threads = preserve(state.threads, (thread) => {
		if (options.activeThreadIds?.includes(thread.id)) return thread;
		const messages = preserve(thread.messages, (message) => {
			const interrupted =
				message.role === 'assistant' &&
				((Boolean(message.phase) && message.completedAt === undefined) ||
					(!message.content && !message.error && !message.toolCalls?.length));
			const toolCalls =
				message.toolCalls &&
				preserve(message.toolCalls, (call) =>
					['running', 'approval'].includes(call.status)
						? {
								...call,
								status: 'failed' as const,
								result: {
									isError: true,
									content: [
										{
											type: 'text' as const,
											text: 'Tool execution was interrupted when FreeLM closed.',
										},
									],
								},
							}
						: call,
				);
			if (toolCalls === message.toolCalls && (!interrupted || message.interrupted === true))
				return message;
			return {
				...message,
				...(interrupted ? { interrupted: true } : {}),
				...(toolCalls !== message.toolCalls ? { toolCalls } : {}),
			};
		});
		const recovered = recoverCodeQueueFailures(
			messages === thread.messages ? thread : { ...thread, messages },
		);
		return recovered.goal?.status === 'active' && !recovered.goal.awaitingResume
			? { ...recovered, goal: { ...recovered.goal, awaitingResume: true } }
			: recovered;
	});
	const generations = preserve(state.generations, (g) =>
		g.status === 'pending' && !(g.kind === 'videos' && g.remoteId)
			? {
					...g,
					status: 'cancelled' as const,
					error: 'This request was interrupted when the app closed.',
				}
			: g,
	);
	if (
		threads === state.threads &&
		generations === state.generations &&
		state.appearance !== undefined &&
		state.debugMode !== undefined &&
		state.systemPrompt !== undefined &&
		state.thinkingPresets !== undefined
	)
		return state;
	return {
		...state,
		threads,
		generations,
		appearance: state.appearance ?? defaultAppearance(),
		debugMode: state.debugMode ?? false,
		systemPrompt: state.systemPrompt ?? '',
		thinkingPresets: state.thinkingPresets ?? defaultThinkingPresets(),
	};
}
export function composeSystemPrompt(systemPrompt?: string, projectInstructions?: string): string {
	return [systemPrompt, projectInstructions]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join('\n\n');
}
export function conversationInput(messages: Message[]): Message[] {
	return messages
		.filter(
			(message) =>
				message.role === 'user' ||
				!!message.agentTranscript?.context ||
				((message.content.trim() || message.agentTranscript?.items.length) && !message.error),
		)
		.map((message) =>
			message.role === 'user' && message.composer?.references?.length
				? { ...message, content: composerVisibleText(message.content) }
				: message,
		);
}
export function downloadText(name: string, content: string, type = 'text/plain') {
	const url = URL.createObjectURL(new Blob([content], { type }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
