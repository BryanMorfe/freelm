import type { AgentContextCheckpoint, AgentContextUsage } from '../agent-types';
import type { Message } from '../types';

type Item = Record<string, unknown>;
export const COMPACTION_PROMPT = `Create a context checkpoint for another assistant continuing this conversation. Summarize the user's goals, current progress, key decisions, constraints and preferences, important files or references, commands and tests already run, results, unresolved problems, and concrete next steps. Preserve facts necessary to continue without repeating completed work. This is a summary request: do not execute tools or answer the original request. Return only a concise, structured continuity summary.`;
export const SUMMARY_PREFIX =
	'Conversation continuity checkpoint (context, not a new user request):\n';

/** Codex's portable fallback is ceil(UTF-8 bytes / 4), not JavaScript string length. */
export function approximateTextTokens(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			i + 1 < text.length &&
			text.charCodeAt(i + 1) >= 0xdc00 &&
			text.charCodeAt(i + 1) <= 0xdfff
		) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return Math.ceil(bytes / 4);
}

/** Do not stringify embedded media: its encoded byte length is unrelated to input tokens. */
function valueTokens(value: unknown, key = '', depth = 0): number {
	if (depth > 32 || value === null || value === undefined) return 0;
	if (typeof value === 'string') {
		if (
			/^data:image\//.test(value) ||
			(['image_url', 'url'].includes(key) && /^https?:\/\//.test(value))
		)
			return 765;
		return approximateTextTokens(value);
	}
	if (Array.isArray(value))
		return value.reduce((total, entry) => total + valueTokens(entry, '', depth + 1), 0);
	if (typeof value === 'object')
		return Object.entries(value).reduce(
			(total, [name, entry]) =>
				total + approximateTextTokens(name) + valueTokens(entry, name, depth + 1),
			0,
		);
	return 1;
}

export function estimateContextTokens(
	items: readonly Item[],
	instructions = '',
	tools: readonly Item[] = [],
): number {
	return (
		approximateTextTokens(instructions) +
		valueTokens(tools) +
		items.reduce((total, item) => total + 4 + valueTokens(item), 0)
	);
}

/** Latest provider input usage plus only newly appended local context, never cumulative requests. */
export class ContextTokenUsage {
	private estimate?: number;
	private actual?: number;
	observe(estimatedInput: number, actualInput?: number) {
		if (actualInput !== undefined && Number.isSafeInteger(actualInput) && actualInput >= 0) {
			this.estimate = estimatedInput;
			this.actual = actualInput;
		}
	}
	count(estimatedInput: number): number {
		return Math.max(
			estimatedInput,
			this.actual === undefined || this.estimate === undefined
				? 0
				: Math.ceil(this.actual + estimatedInput - this.estimate),
		);
	}
	reset() {
		this.estimate = undefined;
		this.actual = undefined;
	}
}

/** Restore only the latest assistant's sample: an older sample may predate a checkpoint. */
export function latestContextUsage(
	history: readonly Message[],
	api: 'responses' | 'chat',
	model: string,
	connectionId: string,
): AgentContextUsage | undefined {
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (message.role !== 'assistant') continue;
		const usage = message.agentTranscript?.usage;
		if (
			message.agentTranscript?.api !== api ||
			!usage ||
			usage.version !== 1 ||
			usage.model !== model ||
			usage.connectionId !== connectionId ||
			!Number.isSafeInteger(usage.estimatedInputTokens) ||
			usage.estimatedInputTokens < 0 ||
			!Number.isSafeInteger(usage.inputTokens) ||
			usage.inputTokens < 0 ||
			!Array.isArray(usage.historyMessageIds) ||
			usage.historyMessageIds.length !== index ||
			!usage.historyMessageIds.every((id, before) => id === history[before].id)
		)
			return undefined;
		return usage;
	}
	return undefined;
}

export function contextOverflow(error: unknown): boolean {
	return (
		error instanceof Error &&
		/context[_ -](?:length[_ -]exceeded|window)|maximum context length|too many (?:input|prompt) tokens|(?:input|prompt).{0,100}(?:exceeds?|larger than).{0,60}(?:context|token limit)|(?:context|token limit).{0,80}exceed/i.test(
			error.message,
		)
	);
}

/** A checkpoint belongs to one exact path and its owning assistant's original transcript. */
export function latestContextCheckpoint(
	history: readonly Message[],
	api: 'responses' | 'chat',
	model: string,
	connectionId: string,
): { index: number; checkpoint: AgentContextCheckpoint } | undefined {
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		const transcript = message.agentTranscript;
		const checkpoint = transcript?.context;
		if (
			message.role !== 'assistant' ||
			transcript?.api !== api ||
			!checkpoint ||
			checkpoint.version !== 1 ||
			checkpoint.api !== api ||
			checkpoint.model !== model ||
			checkpoint.connectionId !== connectionId
		)
			continue;
		if (
			!Number.isInteger(checkpoint.transcriptItemCount) ||
			checkpoint.transcriptItemCount < 0 ||
			checkpoint.transcriptItemCount > transcript.items.length ||
			!Array.isArray(checkpoint.items) ||
			!checkpoint.items.length ||
			!checkpoint.items.every((item) => item && typeof item === 'object' && !Array.isArray(item)) ||
			!Array.isArray(checkpoint.historyMessageIds)
		)
			continue;
		if (
			checkpoint.historyMessageIds.length !== index ||
			!checkpoint.historyMessageIds.every((id, before) => id === history[before].id)
		)
			continue;
		if (
			!completeToolPairs([
				...checkpoint.items,
				...transcript.items.slice(checkpoint.transcriptItemCount),
			])
		)
			continue;
		return { index, checkpoint };
	}
	return undefined;
}

function middleTruncate(text: string, budget: number): string {
	if (approximateTextTokens(text) <= budget) return text;
	const marker = '\n[Earlier request shortened to fit the continuity context.]\n';
	let length = Math.max(0, Math.floor((budget - approximateTextTokens(marker)) * 4));
	while (length > 0) {
		const half = Math.floor(length / 2);
		const result = text.slice(0, half) + marker + text.slice(-Math.max(0, length - half));
		if (approximateTextTokens(result) <= budget) return result;
		length = Math.floor(length * 0.8);
	}
	return '';
}

/** Keep actual recent user requests, newest first within the budget, then chronological order. */
export function compactedContext(
	summary: string,
	history: readonly Message[],
	responses: boolean,
	userTokenBudget: number,
): Item[] {
	const users: Item[] = [];
	let remaining = Math.min(20_000, Math.max(0, Math.floor(userTokenBudget)));
	for (let index = history.length - 1; index >= 0 && remaining > 0; index--) {
		const message = history[index];
		if (message.role !== 'user' || !message.content.trim()) continue;
		const text = middleTruncate(message.content, remaining);
		if (!text) break;
		users.unshift({ role: 'user', content: responses ? [{ type: 'input_text', text }] : text });
		remaining -= approximateTextTokens(text);
		if (text !== message.content) break;
	}
	return [
		...users,
		{
			role: 'user',
			content: responses
				? [{ type: 'input_text', text: SUMMARY_PREFIX + summary.trim() }]
				: SUMMARY_PREFIX + summary.trim(),
		},
	];
}

const object = (value: unknown): Item =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function callIds(item: Item): string[] {
	if (item.type === 'function_call') return [String(item.call_id || '')];
	return array(item.tool_calls).map((entry) => String(object(entry).id || ''));
}
function outputId(item: Item): string | undefined {
	return item.type === 'function_call_output'
		? String(item.call_id || '')
		: item.role === 'tool'
			? String(item.tool_call_id || '')
			: undefined;
}

/** Checkpoint offsets must never leave half a provider tool exchange in the replay tail. */
function completeToolPairs(items: readonly Item[]): boolean {
	const calls = new Map<string, number>();
	const outputs = new Map<string, number>();
	for (const item of items) {
		for (const id of callIds(item)) {
			if (!id) return false;
			calls.set(id, (calls.get(id) || 0) + 1);
		}
		const id = outputId(item);
		if (id !== undefined) {
			if (!id) return false;
			outputs.set(id, (outputs.get(id) || 0) + 1);
		}
	}
	return (
		[...calls].every(([id, count]) => count === 1 && outputs.get(id) === 1) &&
		[...outputs].every(([id, count]) => count === 1 && calls.get(id) === 1)
	);
}

/** Drop oldest protocol item together with every paired tool output/call. Never drop latest user. */
export function trimOldestContextGroup(items: readonly Item[]): Item[] | undefined {
	let latestUser = -1;
	for (let index = items.length - 1; index >= 0; index--)
		if (items[index].role === 'user') {
			latestUser = index;
			break;
		}
	if (items.length < 2) return undefined;
	const first = items[latestUser === 0 ? 1 : 0];
	const ids = new Set(callIds(first));
	const output = outputId(first);
	if (output) ids.add(output);
	const dropped = new Set<Item>([first]);
	for (const item of items)
		if (callIds(item).some((id) => ids.has(id))) {
			dropped.add(item);
			callIds(item).forEach((id) => ids.add(id));
		}
	for (const item of items) if (ids.has(outputId(item) || '')) dropped.add(item);
	if (latestUser >= 0 && dropped.has(items[latestUser])) return undefined;
	return items.filter((item) => !dropped.has(item));
}
