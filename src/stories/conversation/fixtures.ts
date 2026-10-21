import type { ChatActivityPart, ToolCallRecord } from '../../agent-types';
import type { Message } from '../../types';

// Synthetic display data only: importing these fixtures never executes a tool.
export const timestamp = Date.now() - 45_000;

export function commandCall(
	id: string,
	command: string,
	status: ToolCallRecord['status'] = 'completed',
): ToolCallRecord {
	return {
		id,
		name: 'exec_command',
		arguments: JSON.stringify({ cmd: command, workdir: '/workspace/example' }),
		status,
		startedAt: timestamp,
		...(status === 'running' ? {} : { completedAt: timestamp + 2_000 }),
		result:
			status === 'running'
				? undefined
				: {
						content: [
							{
								type: 'text',
								text:
									status === 'failed'
										? 'The command exited with code 1: example test failure.'
										: 'All 24 example checks passed.',
							},
						],
						isError: status === 'failed',
						process: { command, sessionId: `example-${id}`, exitCode: status === 'failed' ? 1 : 0 },
					},
	};
}

export function patchCall(id: string, paths: string[]): ToolCallRecord {
	return {
		id,
		name: 'apply_patch',
		status: 'completed',
		arguments: JSON.stringify({
			patch: [
				'*** Begin Patch',
				...paths.flatMap((path) => [
					`*** Update File: ${path}`,
					'@@',
					'-const spacing = 16;',
					'+const spacing = 12;',
					'+const compact = true;',
					' export { spacing };',
				]),
				'*** End Patch',
			].join('\n'),
		}),
		startedAt: timestamp + 4_000,
		completedAt: timestamp + 5_000,
		result: {
			content: [{ type: 'text', text: 'Applied example patch.' }],
			fileChanges: paths.map((path) => ({ kind: 'update', path, addedLines: 2, removedLines: 1 })),
		},
	};
}

export const searchCall: ToolCallRecord = {
	id: 'search',
	name: 'web.run',
	arguments: JSON.stringify({ search_query: [{ q: 'accessible desktop navigation patterns' }] }),
	status: 'completed',
	startedAt: timestamp,
	completedAt: timestamp + 3_000,
	result: {
		content: [{ type: 'text', text: 'Found two example sources.' }],
		research: {
			sources: [
				{
					id: 'example-source',
					title: 'Accessible navigation',
					url: 'https://example.com/accessibility',
					snippet: 'A local preview of research source metadata.',
				},
				{
					id: 'example-design',
					title: 'Desktop interface design',
					url: 'https://example.org/design',
					snippet: 'A second source to demonstrate citations and the sources capsule.',
				},
			],
		},
	},
};

export const historyCalls = [
	commandCall('list', 'rg --files src/components'),
	commandCall('read', "sed -n '1,120p' src/components/Navigation.tsx"),
	patchCall('navigation', ['src/components/Navigation.tsx']),
	patchCall('theme', ['src/styles/theme.css', 'src/styles/layout.css']),
	commandCall('test', 'npm run test -- navigation', 'running'),
];

export const historyParts: ChatActivityPart[] = [
	{ type: 'text', id: 'intro', text: 'I’ll inspect the navigation and theme tokens first.' },
	...historyCalls
		.slice(0, 2)
		.map((call): ChatActivityPart => ({
			type: 'tool',
			id: `part-${call.id}`,
			toolCallId: call.id,
		})),
	{
		type: 'text',
		id: 'update',
		text: 'The layout uses shared tokens. I’m tightening the spacing while preserving the minimum text size.',
	},
	...historyCalls
		.slice(2)
		.map((call): ChatActivityPart => ({
			type: 'tool',
			id: `part-${call.id}`,
			toolCallId: call.id,
		})),
];

export const assistantMessage: Message = {
	id: 'example-assistant',
	role: 'assistant',
	content:
		'Updated the navigation spacing and verified keyboard access.\n\n- Labels keep their standard size.\n- Long names truncate within the available width.\n- Narrow windows reflow without horizontal scrolling.',
	createdAt: timestamp,
	completedAt: timestamp + 20_000,
	activityFinishedAt: timestamp + 18_000,
};
