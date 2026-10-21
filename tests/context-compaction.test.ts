import { describe, expect, it } from 'vitest';
import type { AgentContextCheckpoint } from '../src/agent-types';
import type { Message } from '../src/types';
import {
	approximateTextTokens,
	compactedContext,
	ContextTokenUsage,
	contextOverflow,
	estimateContextTokens,
	latestContextCheckpoint,
	latestContextUsage,
	SUMMARY_PREFIX,
	trimOldestContextGroup,
} from '../src/lib/context-compaction';

const user = (id: string, content = 'Continue the project'): Message => ({
	id,
	role: 'user',
	content,
	createdAt: 1,
});
const checkpoint = (): AgentContextCheckpoint => ({
	version: 1,
	api: 'responses',
	model: 'test',
	connectionId: 'local',
	historyMessageIds: ['u'],
	transcriptItemCount: 2,
	items: [{ role: 'user', content: SUMMARY_PREFIX + 'Finished first step.' }],
	createdAt: 2,
	compactionCount: 1,
	inputTokensBefore: 2000,
	inputTokensAfter: 30,
});
const assistant = (): Message => ({
	id: 'a',
	role: 'assistant',
	content: 'Done',
	createdAt: 2,
	agentTranscript: {
		api: 'responses',
		items: [
			{ type: 'function_call', call_id: 'c' },
			{ type: 'function_call_output', call_id: 'c', output: 'Result' },
			{ role: 'assistant', content: 'Done' },
		],
		context: checkpoint(),
	},
});

describe('portable context compaction helpers', () => {
	it('estimates UTF-8 tokens and media without serializing large encoded images', () => {
		expect(approximateTextTokens('abcd')).toBe(1);
		expect(approximateTextTokens('😀')).toBe(1);
		expect(approximateTextTokens('界界')).toBe(2);
		const item = (data: string) => ({
			role: 'user',
			content: [{ type: 'input_image', image_url: data }],
		});
		expect(estimateContextTokens([item('data:image/png;base64,AAAA')])).toBe(
			estimateContextTokens([item('data:image/png;base64,' + 'A'.repeat(1_000_000))]),
		);
		expect(
			estimateContextTokens([], 'x'.repeat(400), [{ name: 'tool', description: 'x'.repeat(400) }]),
		).toBeGreaterThan(200);
	});
	it('uses latest provider usage plus appended context, never sums every request', () => {
		const usage = new ContextTokenUsage();
		usage.observe(100, 500);
		expect(usage.count(150)).toBe(550);
		usage.observe(150, 600);
		expect(usage.count(200)).toBe(650);
		usage.reset();
		expect(usage.count(200)).toBe(200);
	});
	it('retains recent real user text chronologically with middle truncation and no embedded assets', () => {
		const content = 'START ' + 'x'.repeat(10_000) + ' END';
		const users = [
			user('old', 'Older preference'),
			{
				...user('latest', content),
				attachments: [
					{
						id: 'image',
						name: 'private.png',
						type: 'image/png',
						dataUrl: 'data:image/png;base64,AAAA',
					},
				],
			},
		];
		const result = compactedContext('Important factual state', users, false, 100);
		expect(result).toHaveLength(2);
		expect(result[0].content).toContain('START');
		expect(result[0].content).toContain('END');
		expect(result[0].content).toContain('shortened');
		expect(approximateTextTokens(String(result[0].content))).toBeLessThanOrEqual(100);
		expect(JSON.stringify(result)).not.toContain('base64');
		expect(result.at(-1)?.content).toBe(SUMMARY_PREFIX + 'Important factual state');
		const full = compactedContext('State', [user('a', 'First'), user('b', 'Second')], true, 20_000);
		expect(full.slice(0, 2).map((item) => (item.content as { text: string }[])[0].text)).toEqual([
			'First',
			'Second',
		]);
	});
	it('accepts only a checkpoint owned by the exact active prefix, endpoint, model and connection', () => {
		const messages = [user('u'), assistant(), user('next')];
		expect(latestContextCheckpoint(messages, 'responses', 'test', 'local')?.index).toBe(1);
		expect(
			latestContextCheckpoint(
				[{ ...messages[0], id: 'edited' }, ...messages.slice(1)],
				'responses',
				'test',
				'local',
			),
		).toBeUndefined();
		expect(latestContextCheckpoint(messages, 'chat', 'test', 'local')).toBeUndefined();
		expect(latestContextCheckpoint(messages, 'responses', 'other', 'local')).toBeUndefined();
		expect(latestContextCheckpoint(messages, 'responses', 'test', 'remote')).toBeUndefined();
		messages[1].agentTranscript!.context!.transcriptItemCount = 99;
		expect(latestContextCheckpoint(messages, 'responses', 'test', 'local')).toBeUndefined();
	});
	it('ignores malformed checkpoints in unchecked histories rather than breaking replay', () => {
		const message = assistant();
		message.agentTranscript!.context = {
			...checkpoint(),
			historyMessageIds: undefined,
		} as unknown as AgentContextCheckpoint;
		expect(
			latestContextCheckpoint([user('u'), message], 'responses', 'test', 'local'),
		).toBeUndefined();
	});
	it('ignores a saved checkpoint whose offset cuts a tool exchange in half', () => {
		const message = assistant();
		message.agentTranscript!.context!.transcriptItemCount = 1;
		expect(
			latestContextCheckpoint([user('u'), message], 'responses', 'test', 'local'),
		).toBeUndefined();
		message.agentTranscript!.context!.transcriptItemCount = 0;
		expect(latestContextCheckpoint([user('u'), message], 'responses', 'test', 'local')?.index).toBe(
			1,
		);
	});
	it('restores anchored usage only from the most recent assistant on the same active prefix', () => {
		const message = assistant();
		message.agentTranscript!.usage = {
			version: 1,
			model: 'test',
			connectionId: 'local',
			historyMessageIds: ['u'],
			estimatedInputTokens: 100,
			inputTokens: 500,
		};
		expect(
			latestContextUsage([user('u'), message, user('next')], 'responses', 'test', 'local')
				?.inputTokens,
		).toBe(500);
		expect(
			latestContextUsage([user('edited'), message], 'responses', 'test', 'local'),
		).toBeUndefined();
		expect(latestContextUsage([user('u'), message], 'responses', 'test', 'remote')).toBeUndefined();
		expect(latestContextUsage([user('u'), message], 'chat', 'test', 'local')).toBeUndefined();
		expect(
			latestContextUsage(
				[
					user('u'),
					message,
					{ id: 'no-usage', role: 'assistant', content: 'New answer', createdAt: 3 },
				],
				'responses',
				'test',
				'local',
			),
		).toBeUndefined();
	});
	it.each(['responses', 'chat'])(
		'trims complete %s tool pairs while protecting the latest user request',
		(api) => {
			const calls =
				api === 'responses'
					? [
							{ type: 'function_call', call_id: 'a' },
							{ type: 'function_call', call_id: 'b' },
						]
					: [{ role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] }];
			const outputs =
				api === 'responses'
					? [
							{ type: 'function_call_output', call_id: 'a', output: 'A' },
							{ type: 'function_call_output', call_id: 'b', output: 'B' },
						]
					: [
							{ role: 'tool', tool_call_id: 'a', content: 'A' },
							{ role: 'tool', tool_call_id: 'b', content: 'B' },
						];
			const latest = { role: 'user', content: 'Continue safely' };
			const trimmed = trimOldestContextGroup([...calls, ...outputs, latest])!;
			expect(trimmed).toContain(latest);
			expect(JSON.stringify(trimmed)).not.toContain('"a"');
			if (api === 'chat') expect(trimmed).toEqual([latest]);
			const withFirstUser = trimOldestContextGroup([latest, ...calls, ...outputs]);
			expect(withFirstUser).toContain(latest);
			expect(trimOldestContextGroup([latest])).toBeUndefined();
		},
	);
	it('retries only explicit provider context rejection errors', () => {
		expect(contextOverflow(new Error('API 400: context_length_exceeded'))).toBe(true);
		expect(contextOverflow(new Error('maximum context length is 32768 tokens'))).toBe(true);
		expect(contextOverflow(new Error('The prompt exceeds the token limit'))).toBe(true);
		expect(contextOverflow(new Error('API 503: busy'))).toBe(false);
		expect(contextOverflow(new Error('The model output exceeds the 2 MB text limit.'))).toBe(false);
	});
});
