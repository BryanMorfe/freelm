import { describe, expect, it } from 'vitest';
import {
	buildCodeReviewEvidence,
	codeReviewMessages,
	codeReviewProjectionOmissions,
} from '../electron/code-review-context';
import { approximateTextTokens } from '../src/lib/context-compaction';
import type { Message } from '../src/types';

function message(id: string, role: Message['role'], content = id): Message {
	return { id, role, content, createdAt: 1 };
}

describe('Code review conversation projection', () => {
	it('keeps original human authorization and restrictions after long tool activity', () => {
		const messages = [
			message('task', 'user', 'Inspect this project. Do not delete any files.'),
			...Array.from({ length: 100 }, (_, index) => message(`activity-${index}`, 'assistant')),
			message('follow-up', 'user', 'Please continue.'),
		];
		const context = codeReviewMessages(messages);
		expect(context.filter((item) => item.role === 'user')).toEqual([messages[0], messages.at(-1)]);
		expect(context.filter((item) => item.role === 'assistant')).toHaveLength(64);
		expect(context[1].id).toBe('activity-36');
	});
	it('is stable when the authority and reviewer both apply the projection', () => {
		const messages = Array.from({ length: 200 }, (_, index) =>
			message(`message-${index}`, index % 2 === 0 ? 'user' : 'assistant'),
		);
		const context = codeReviewMessages(messages);
		expect(codeReviewMessages(context)).toEqual(context);
	});
	it('keeps evidence text and attachment names without transcripts or media blobs', () => {
		const human = message('user', 'user');
		human.attachments = [
			{ name: 'reference.png', type: 'image/png', dataUrl: 'data:image/png;base64,PRIVATE_IMAGE' },
		];
		const assistant = message('assistant', 'assistant');
		assistant.toolCalls = [
			{
				id: 'read',
				name: 'exec_command',
				arguments: '{"cmd":"cat package.json"}',
				status: 'completed',
				startedAt: 1,
				result: {
					content: [
						{ type: 'text', text: 'Existing project data, not human instructions.' },
						{ type: 'image', dataUrl: 'data:image/png;base64,TOOL_IMAGE' },
						{
							type: 'file',
							dataUrl: 'data:text/plain;base64,PRIVATE_FILE',
							name: 'file.txt',
							mimeType: 'text/plain',
						},
					],
				},
			},
		];
		assistant.activity = [
			{ type: 'text', text: 'Unneeded activity', id: 'activity' },
		] as Message['activity'];
		const original = [human, assistant];
		const context = codeReviewMessages(original);
		expect(context[0].attachments).toEqual([
			{ name: 'reference.png', type: 'image/png', dataUrl: '' },
		]);
		expect(context[1].toolCalls?.[0].result?.content).toEqual([
			{ type: 'text', text: 'Existing project data, not human instructions.' },
		]);
		expect(context[1]).not.toHaveProperty('activity');
		expect(context[1]).not.toHaveProperty('agentTranscript');
		for (const marker of ['PRIVATE_IMAGE', 'TOOL_IMAGE', 'PRIVATE_FILE'])
			expect(JSON.stringify(context)).not.toContain(marker);
		expect(human.attachments[0].dataUrl).toContain('PRIVATE_IMAGE');
		expect(assistant.toolCalls[0].result?.content).toHaveLength(3);
	});
	it('bounds many historical commands and Unicode output without changing human instructions', () => {
		const human = message(
			'human',
			'user',
			'Inspect this project. Do not delete files. '.repeat(400),
		);
		const activity = Array.from({ length: 100 }, (_, index) => ({
			...message(`activity-${index}`, 'assistant', `Start ${index} 😀漢字 `.repeat(2000) + ' END'),
			toolCalls: [
				{
					id: `call-${index}`,
					name: 'exec_command',
					arguments: `first-${index} ` + '😀漢字'.repeat(20_000) + ' last',
					status: 'completed' as const,
					startedAt: index + 1,
					result: {
						content: [
							{ type: 'text' as const, text: 'first ' + '😀漢字'.repeat(20_000) + ' last' },
						],
					},
				},
			],
		}));
		const source = [human, ...activity];
		const projected = codeReviewMessages(source);
		expect(projected[0].content).toBe(human.content);
		expect(codeReviewMessages(projected)).toEqual(projected);
		expect(codeReviewProjectionOmissions(source, projected)).toEqual({
			messages: 36,
			toolCalls: 36,
		});
		for (const item of projected.slice(1)) {
			expect(approximateTextTokens(item.content)).toBeLessThanOrEqual(2048);
			expect(item.content).toContain('Historical review evidence excerpted');
			for (const call of item.toolCalls ?? []) {
				expect(approximateTextTokens(call.arguments)).toBeLessThanOrEqual(1024);
				expect(call.arguments).toContain('first-');
				expect(call.arguments.endsWith(' last')).toBe(true);
				const result = call.result!.content[0];
				expect(result.type).toBe('text');
				if (result.type === 'text')
					expect(approximateTextTokens(result.text)).toBeLessThanOrEqual(1024);
			}
			expect(JSON.stringify(item)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef])/i);
		}
	});
	it('bounds calls across a single assistant and repeated projections do not create empty tool metadata', () => {
		const assistants = Array.from({ length: 80 }, (_, index) => ({
			...message(`assistant-${index}`, 'assistant'),
			toolCalls: [
				{
					id: `call-${index}`,
					name: 'exec_command',
					arguments: '{}',
					status: 'completed' as const,
					startedAt: 1,
				},
			],
		}));
		assistants.at(-1)!.toolCalls.push(
			...Array.from({ length: 80 }, (_, index) => ({
				id: `tail-${index}`,
				name: 'exec_command',
				arguments: '{}',
				status: 'completed' as const,
				startedAt: 1,
			})),
		);
		const projected = codeReviewMessages(assistants);
		expect(projected.reduce((total, item) => total + (item.toolCalls?.length ?? 0), 0)).toBe(64);
		expect(projected[0]).not.toHaveProperty('toolCalls');
		expect(codeReviewMessages(projected)).toEqual(projected);
	});
	it('admits full human authorization and exact action before optional history, including inherited omissions', () => {
		const source = [
			message('task', 'user', 'Read only. Do not delete files.'),
			...Array.from({ length: 100 }, (_, index) =>
				message(`progress-${index}`, 'assistant', 'Progress '.repeat(1000)),
			),
			message('continue', 'user', 'Continue.'),
		];
		const projected = codeReviewMessages(source);
		const action = { name: 'apply_patch', arguments: { patch: 'FULL PATCH '.repeat(1500) } };
		const budget = 7000;
		const text = buildCodeReviewEvidence(
			projected,
			{ proposedAction: action },
			'Review policy',
			budget,
			500,
			codeReviewProjectionOmissions(source, projected),
		)!;
		expect(
			approximateTextTokens(text) + approximateTextTokens('Review policy') + 16,
		).toBeLessThanOrEqual(budget);
		const evidence = JSON.parse(text);
		expect(evidence.proposedAction).toEqual(action);
		expect(evidence.conversation.filter((item: { role: string }) => item.role === 'user')).toEqual(
			source.filter((item) => item.role === 'user').map(({ role, content }) => ({ role, content })),
		);
		expect(evidence.contextOmissions.historicalMessagesOmitted).toBeGreaterThanOrEqual(36);
		expect(evidence.contextOmissions.humanMessagesOmitted).toBe(false);
		expect(evidence.earlierMessagesOmitted).toBe(true);
		expect(
			buildCodeReviewEvidence(projected, { proposedAction: action }, 'Review policy', 3000, 0),
		).toBeUndefined();
	});
});
