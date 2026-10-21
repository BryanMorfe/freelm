import type { Message, Thread } from '../src/types';
import { approximateTextTokens } from '../src/lib/context-compaction';

const MAX_RECENT_ACTIVITY_MESSAGES = 64;
const MAX_RECENT_TOOL_CALLS = 64;
const EXCERPT_MARKER = '[Historical review evidence excerpted; omitted content is unavailable.]';

export interface CodeReviewOmissions {
	messages: number;
	toolCalls: number;
}

/** Review-only host metadata, never part of the durable/UI thread schema. */
export type CodeReviewThread = Thread & { reviewEvidenceOmissions?: CodeReviewOmissions };

export function codeReviewProjectionOmissions(
	messages: readonly Message[],
	projected: readonly Message[],
): CodeReviewOmissions {
	return {
		messages:
			messages.filter((message) => message.role !== 'user').length -
			projected.filter((message) => message.role !== 'user').length,
		toolCalls:
			messages.reduce(
				(total, message) =>
					total + (message.role !== 'user' ? (message.toolCalls?.length ?? 0) : 0),
				0,
			) - projected.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0),
	};
}

/** Codex Guardian keeps UTF-8-safe prefix/suffix excerpts with an explicit omission notice. */
function evidenceExcerpt(text: string, tokens: number): string {
	const maxBytes = tokens * 4;
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
	const budget = Math.max(0, Math.floor((maxBytes - Buffer.byteLength(EXCERPT_MARKER)) / 2));
	if (budget === 0) return EXCERPT_MARKER;
	let prefix = text.slice(0, budget);
	let suffix = text.slice(-budget);
	while (Buffer.byteLength(prefix, 'utf8') > budget)
		prefix = prefix.slice(0, Math.floor(prefix.length * 0.8));
	while (Buffer.byteLength(suffix, 'utf8') > budget)
		suffix = suffix.slice(Math.ceil(suffix.length * 0.2));
	if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
	if (/^[\uDC00-\uDFFF]/.test(suffix)) suffix = suffix.slice(1);
	return `${prefix}${EXCERPT_MARKER}${suffix}`;
}

/** Human requests stay complete; historical assistant/tool evidence is bounded before copying. */
export function codeReviewMessages(messages: readonly Message[]): Message[] {
	const recentActivityIds = new Set(
		messages
			.filter((message) => message.role !== 'user')
			.slice(-MAX_RECENT_ACTIVITY_MESSAGES)
			.map((message) => message.id),
	);
	const recentCallIds = new Set(
		messages
			.filter((message) => message.role !== 'user' && recentActivityIds.has(message.id))
			.flatMap((message) => message.toolCalls ?? [])
			.slice(-MAX_RECENT_TOOL_CALLS)
			.map((call) => call.id),
	);
	return messages
		.filter((message) => message.role === 'user' || recentActivityIds.has(message.id))
		.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.role === 'user' ? message.content : evidenceExcerpt(message.content, 2048),
			createdAt: message.createdAt,
			...(message.replyTo ? { replyTo: { ...message.replyTo } } : {}),
			...(message.attachments?.length
				? {
						attachments: message.attachments.map((attachment) => ({
							name: attachment.name,
							type: attachment.type,
							dataUrl: '',
						})),
					}
				: {}),
			...(message.role !== 'user' && message.toolCalls?.some((call) => recentCallIds.has(call.id))
				? {
						toolCalls: message.toolCalls
							.filter((call) => recentCallIds.has(call.id))
							.map((call) => ({
								id: call.id,
								name: call.name,
								arguments: evidenceExcerpt(call.arguments, 1024),
								status: call.status,
								startedAt: call.startedAt,
								...(call.completedAt !== undefined ? { completedAt: call.completedAt } : {}),
								...(call.result
									? {
											result: {
												...(call.result.isError ? { isError: true } : {}),
												content: boundedResultText(call.result.content),
											},
										}
									: {}),
							})),
					}
				: {}),
		}));
}

function boundedResultText(
	content: NonNullable<NonNullable<Message['toolCalls']>[number]['result']>['content'],
) {
	const parts = content.filter((part) => part.type === 'text');
	const text = parts.map((part) => part.text).join('\n');
	return approximateTextTokens(text) <= 1024
		? parts.map((part) => ({ type: 'text' as const, text: part.text }))
		: [{ type: 'text' as const, text: evidenceExcerpt(text, 1024) }];
}

type EvidenceMessage = {
	role: Message['role'];
	content: string;
	selectedText?: string;
	attachments?: { name: string; type: string }[];
	toolEvidence?: {
		name: string;
		arguments: string;
		status: string;
		result?: ReturnType<typeof boundedResultText>;
	}[];
};

/** Required human/action evidence is admitted first; only historical machine evidence may shrink. */
export function buildCodeReviewEvidence(
	messages: readonly Message[],
	fixedEvidence: Record<string, unknown>,
	instructions: string,
	maxInputTokens: number,
	historyTokenBudget: number,
	inheritedOmissions: CodeReviewOmissions = { messages: 0, toolCalls: 0 },
): string | undefined {
	const projected = codeReviewMessages(messages);
	const omitted = codeReviewProjectionOmissions(messages, projected);
	const sourceMachineMessages = projected.filter((message) => message.role !== 'user').length;
	const sourceCalls = projected.reduce(
		(total, message) => total + (message.toolCalls?.length ?? 0),
		0,
	);
	const excerpts = JSON.stringify(projected.filter((message) => message.role !== 'user')).includes(
		EXCERPT_MARKER,
	);
	const records = new Map<number, EvidenceMessage>();
	for (const [index, message] of projected.entries())
		if (message.role === 'user') records.set(index, evidenceMessage(message));
	const render = () => {
		const conversation = [...records]
			.sort(([left], [right]) => left - right)
			.map(([, item]) => item);
		const retainedMachine = [...records].filter(([, item]) => item.role !== 'user');
		return JSON.stringify({
			...fixedEvidence,
			conversation,
			earlierMessagesOmitted:
				inheritedOmissions.messages > 0 || conversation.length < messages.length,
			contextOmissions: {
				humanMessagesOmitted: false,
				proposedActionComplete: true,
				historicalEvidenceExcerpted: excerpts,
				historicalMessagesOmitted:
					inheritedOmissions.messages +
					omitted.messages +
					sourceMachineMessages -
					retainedMachine.length,
				historicalToolCallsOmitted:
					inheritedOmissions.toolCalls +
					omitted.toolCalls +
					sourceCalls -
					retainedMachine.reduce(
						(total, [, message]) => total + (message.toolEvidence?.length ?? 0),
						0,
					),
				notice:
					'Historical assistant and tool evidence may be excerpted or omitted. Do not infer missing script behavior or the referent of a brief human reply from missing assistant context.',
			},
		});
	};
	const fixedTokens = approximateTextTokens(instructions) + 16;
	const minimum = render();
	const minimumTokens = fixedTokens + approximateTextTokens(minimum);
	if (minimumTokens > maxInputTokens) return undefined;
	const optionalLimit = Math.min(maxInputTokens, minimumTokens + Math.max(0, historyTokenBudget));
	const tryRecord = (index: number, next: EvidenceMessage) => {
		const previous = records.get(index);
		records.set(index, next);
		if (fixedTokens + approximateTextTokens(render()) <= optionalLimit) return;
		if (previous) records.set(index, previous);
		else records.delete(index);
	};
	// Preserve conversational context for genuine replies before unrelated historic command output.
	const adjacent = new Set<number>();
	for (let index = 1; index < projected.length; index++)
		if (projected[index].role === 'user' && projected[index - 1].role !== 'user')
			adjacent.add(index - 1);
	const machineIndices = projected
		.map((_, index) => index)
		.filter((index) => projected[index].role !== 'user')
		.reverse();
	const contentOrder = [
		...machineIndices.filter((index) => adjacent.has(index)),
		...machineIndices.filter((index) => !adjacent.has(index)),
	];
	for (const index of contentOrder) tryRecord(index, evidenceMessage(projected[index]));
	for (const index of machineIndices) {
		const message = projected[index];
		for (const call of [...(message.toolCalls ?? [])].reverse()) {
			const current = records.get(index) ?? { role: message.role, content: '' };
			const toolEvidence = [
				{
					name: call.name,
					arguments: call.arguments,
					status: call.status,
					...(call.result ? { result: boundedResultText(call.result.content) } : {}),
				},
				...(current.toolEvidence ?? []),
			];
			tryRecord(index, { ...current, toolEvidence });
		}
	}
	return render();
}

function evidenceMessage(message: Message): EvidenceMessage {
	return {
		role: message.role,
		content: message.content,
		...(message.replyTo ? { selectedText: message.replyTo.text } : {}),
		...(message.attachments?.length
			? { attachments: message.attachments.map(({ name, type }) => ({ name, type })) }
			: {}),
	};
}
