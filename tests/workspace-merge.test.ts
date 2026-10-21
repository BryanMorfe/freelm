import { describe, expect, it } from 'vitest';
import { mergeWorkspaceState } from '../src/lib/workspace-merge';
import { initialState, recoverState } from '../src/lib/state';
import type { AppState, Thread } from '../src/types';
const fixture = () => {
	const state = initialState();
	state.threads = [
		{
			id: 'task',
			kind: 'code',
			title: 'Task',
			connectionId: state.activeConnectionId,
			model: 'test',
			createdAt: 1,
			updatedAt: 1,
			messages: [
				{ id: 'a', role: 'assistant', content: 'Working', phase: 'working', createdAt: 1 },
			],
		},
	];
	return state;
};
const change = (state: AppState, fn: (thread: Thread) => Thread): AppState => ({
	...state,
	threads: state.threads.map(fn),
});
describe('concurrent host checkpoint and renderer edit merge', () => {
	it('merges a media workspace larger than the maximum serialized string without serializing it', () => {
		const base = fixture();
		// 640 MiB if flattened, but only one shared 8 MiB immutable media string.
		// This models reused image references in a real saved workspace without a large test allocation.
		const dataUrl = `data:image/png;base64,${'a'.repeat(8 * 1024 * 1024)}`;
		base.threads[0].messages[0].attachments = Array.from({ length: 80 }, (_, index) => ({
			name: `image-${index}.png`,
			type: 'image/png',
			dataUrl,
		}));
		const copyThread = (thread: Thread): Thread => ({
			...thread,
			messages: thread.messages.map((message) => ({
				...message,
				attachments: message.attachments?.map((attachment) => ({ ...attachment })),
			})),
		});
		const local = {
			...change(base, copyThread),
			chatDrafts: { task: { content: 'Keep this draft', attachments: [], updatedAt: 5 } },
		};
		const remote = change(base, (thread) => ({ ...copyThread(thread), title: 'Host update' }));
		const merged = mergeWorkspaceState(base, local, remote);
		expect(merged.chatDrafts?.task.content).toBe('Keep this draft');
		expect(merged.threads[0].title).toBe('Host update');
		expect(merged.threads[0].messages[0].attachments).toHaveLength(80);
		expect(
			merged.threads[0].messages[0].attachments?.every((item) => item.dataUrl === dataUrl),
		).toBe(true);
	});
	it('treats reordered keys and omitted optional fields as the same stored state', () => {
		const base = fixture();
		const local = change(base, (thread) => ({
			...thread,
			messages: thread.messages.map((message) => ({
				createdAt: message.createdAt,
				content: message.content,
				role: message.role,
				id: message.id,
				phase: message.phase,
				attachments: undefined,
			})),
		}));
		const remote = change(base, (thread) => ({
			...thread,
			messages: thread.messages.map((message) => ({ ...message, content: 'Completed' })),
		}));
		expect(mergeWorkspaceState(base, local, remote)).toBe(remote);
	});
	it('keeps a composer draft and host answer without replacing either', () => {
		const base = fixture();
		const local = {
			...base,
			chatDrafts: { task: { content: 'Unsaved follow-up', attachments: [], updatedAt: 5 } },
		};
		const remote = change(base, (thread) => ({
			...thread,
			updatedAt: 4,
			messages: thread.messages.map((message) => ({
				...message,
				content: 'Completed',
				completedAt: 4,
			})),
		}));
		const merged = mergeWorkspaceState(base, local, remote);
		expect(merged.chatDrafts?.task.content).toBe('Unsaved follow-up');
		expect(merged.threads[0].messages[0].content).toBe('Completed');
	});
	it('merges queued input and independent streaming output within the same task', () => {
		const base = fixture();
		const local = change(base, (thread) => ({
			...thread,
			updatedAt: 9,
			queuedMessages: [{ id: 'queue', content: 'Correction', createdAt: 8 }],
		}));
		const remote = change(base, (thread) => ({
			...thread,
			updatedAt: 10,
			messages: thread.messages.map((message) => ({ ...message, content: 'Intermediate update' })),
		}));
		const merged = mergeWorkspaceState(base, local, remote);
		expect(merged.threads[0].queuedMessages?.[0].content).toBe('Correction');
		expect(merged.threads[0].messages[0].content).toBe('Intermediate update');
		expect(merged.threads[0].updatedAt).toBe(10);
	});
	it('keeps independent new conversations from both writers', () => {
		const base = fixture();
		const local = { ...base, threads: [...base.threads, { ...base.threads[0], id: 'local' }] };
		const remote = { ...base, threads: [...base.threads, { ...base.threads[0], id: 'host' }] };
		expect(mergeWorkspaceState(base, local, remote).threads.map((thread) => thread.id)).toEqual([
			'task',
			'local',
			'host',
		]);
	});
	it('rejects overlapping edits instead of silently overwriting a streaming transcript', () => {
		const base = fixture();
		const edit = (text: string) =>
			change(base, (thread) => ({
				...thread,
				messages: thread.messages.map((message) => ({ ...message, content: text })),
			}));
		expect(() => mergeWorkspaceState(base, edit('Human edit'), edit('New model output'))).toThrow(
			'WORKSPACE_CONFLICT',
		);
	});
	it('rejects deleting a conversation that changed on the host', () => {
		const base = fixture();
		const remote = change(base, (thread) => ({ ...thread, title: 'Renamed' }));
		expect(() => mergeWorkspaceState(base, { ...base, threads: [] }, remote)).toThrow(
			'WORKSPACE_CONFLICT',
		);
	});
	it('does not mark running host tasks interrupted when a window opens', () => {
		const state = fixture();
		expect(recoverState(state).threads[0].messages[0].interrupted).toBe(true);
		expect(
			recoverState(state, { activeThreadIds: ['task'] }).threads[0].messages[0].interrupted,
		).toBeUndefined();
	});
});
