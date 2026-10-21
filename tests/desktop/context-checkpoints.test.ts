import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../../src/lib/state';
import type { AgentContextCheckpoint, ToolCallRecord } from '../../src/agent-types';
import { StateStore } from '../../electron/state-store';
import { validateState } from '../../electron/validation';
import {
	applyWorkspacePatch,
	assertWorkspacePatch,
	createWorkspacePatch,
} from '../../src/workspace-patch';

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
	);
});
const secrets = {
	available: () => false,
	encrypt: () => {
		throw new Error('No keys');
	},
	decrypt: () => {
		throw new Error('No keys');
	},
};
const checkpoint = (): AgentContextCheckpoint => ({
	version: 1,
	api: 'responses',
	model: 'fixture-model',
	connectionId: 'default',
	historyMessageIds: ['user'],
	transcriptItemCount: 2100,
	items: [
		{
			role: 'user',
			content: 'Continuity summary: inspection is complete; next run the integration checks.',
		},
	],
	createdAt: 2000,
	compactionCount: 3,
	inputTokensBefore: 60000,
	inputTokensAfter: 1000,
});

function fixture() {
	const state = initialState();
	const calls: ToolCallRecord[] = Array.from({ length: 700 }, (_, index) => ({
		id: `call-${index}`,
		name: 'exec_command',
		arguments: '{"cmd":"pwd"}',
		status: 'completed',
		startedAt: 1000 + index,
		completedAt: 1001 + index,
		result: {
			content: [
				{
					type: 'text',
					text: index === 0 ? 'Original detailed output. '.repeat(4000) : 'Original output.',
				},
			],
		},
	}));
	const items = calls.flatMap((call) => [
		{
			type: 'message',
			role: 'assistant',
			content: [{ type: 'output_text', text: 'Inspecting the next case.' }],
		},
		{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments },
		{ type: 'function_call_output', call_id: call.id, output: 'Original output.' },
	]);
	items.push({
		type: 'message',
		role: 'assistant',
		content: [{ type: 'output_text', text: 'Finished.' }],
	});
	const context = { ...checkpoint(), connectionId: state.activeConnectionId };
	state.threads = [
		{
			id: 'long-task',
			kind: 'code',
			title: 'Long task',
			connectionId: state.activeConnectionId,
			model: 'fixture-model',
			createdAt: 1,
			updatedAt: 3000,
			messages: [
				{ id: 'user', role: 'user', content: 'Inspect the complete project.', createdAt: 1 },
				{
					id: 'answer',
					parentId: 'user',
					role: 'assistant',
					content: 'Finished.',
					createdAt: 1000,
					completedAt: 3000,
					phase: 'responding',
					toolCalls: calls,
					agentTranscript: {
						api: 'responses',
						items,
						context,
						usage: {
							version: 1,
							model: 'fixture-model',
							connectionId: state.activeConnectionId,
							historyMessageIds: ['user'],
							estimatedInputTokens: 5000,
							inputTokens: 7000,
						},
					},
					activity: calls.flatMap((call) => [
						{ type: 'text' as const, id: `text-${call.id}`, text: 'Inspecting the next case.' },
						{ type: 'tool' as const, id: `tool-${call.id}`, toolCallId: call.id },
					]),
				},
			],
		},
	];
	return state;
}

describe('compacted conversation persistence', () => {
	it('saves and restores checkpoints and original long-run history beyond the former record limits', async () => {
		const state = fixture();
		expect(() => validateState(state)).not.toThrow();
		const folder = await mkdtemp(path.join(os.tmpdir(), 'freelm-context-store-'));
		folders.push(folder);
		const file = path.join(folder, 'workspace.json');
		const config = path.join(folder, 'config.json');
		await new StateStore(file, secrets, config).save(state);
		const restored = await new StateStore(file, secrets, config).load();
		expect(restored).toEqual(state);
		expect(restored!.threads[0].messages[1].toolCalls).toHaveLength(700);
		expect(restored!.threads[0].messages[1].agentTranscript!.items).toHaveLength(2101);
		expect(restored!.threads[0].messages[1].activity).toHaveLength(1400);
	});

	it('retains checkpoints through the same workspace patch used for remote and incremental saves', () => {
		const before = fixture();
		const next = structuredClone(before);
		next.threads[0].messages[1].agentTranscript!.context!.compactionCount = 4;
		next.threads[0].messages[1].agentTranscript!.context!.items = [
			{ role: 'user', content: 'Updated continuity summary.' },
		];
		const patch = createWorkspacePatch(before, next);
		assertWorkspacePatch(patch);
		expect(applyWorkspacePatch(before, patch)).toEqual(next);
		expect(before.threads[0].messages[1].agentTranscript!.context!.compactionCount).toBe(3);
	});

	it('accepts compacting progress but rejects malformed checkpoints rather than losing their history', () => {
		const state = fixture();
		state.threads[0].messages[1].phase = 'compacting';
		expect(() => validateState(state)).not.toThrow();
		for (const patch of [
			{ version: 2 },
			{ api: 'other' },
			{ transcriptItemCount: 2102 },
			{ transcriptItemCount: -1 },
			{ historyMessageIds: ['\0bad'] },
			{ compactionCount: 0 },
			{ inputTokensAfter: 60001 },
			{ items: [] },
		]) {
			const invalid = structuredClone(state);
			Object.assign(invalid.threads[0].messages[1].agentTranscript!.context!, patch);
			expect(() => validateState(invalid)).toThrow('Workspace data is invalid');
		}
	});
	it('validates saved provider usage independently of the checkpoint', () => {
		const state = fixture();
		for (const patch of [
			{ version: 2 },
			{ model: '' },
			{ connectionId: '\0bad' },
			{ historyMessageIds: ['\0bad'] },
			{ estimatedInputTokens: -1 },
			{ estimatedInputTokens: 1.5 },
			{ inputTokens: NaN },
			{ inputTokens: -1 },
		]) {
			const invalid = structuredClone(state);
			Object.assign(invalid.threads[0].messages[1].agentTranscript!.usage!, patch);
			expect(() => validateState(invalid)).toThrow('Workspace data is invalid');
		}
	});
});
