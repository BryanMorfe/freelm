import type { ToolDefinition } from '../agent-types';
export const codeContextTools: ToolDefinition[] = [
	{
		name: 'get_context_remaining',
		source: 'builtin',
		description:
			'Read this active model context capacity, estimated input tokens and remaining tokens. Counts are estimates corrected by provider input usage when available; the configured capacity is not a provider guarantee.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'new_context',
		source: 'builtin',
		description:
			'Start a fresh model context without summarizing older messages, at the next completed tool boundary. Keeps the latest user request and this round’s complete tool exchange. Execution state, original history, scratch notes, and memory survive. Save important working state to notes before using this.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
	},
];
