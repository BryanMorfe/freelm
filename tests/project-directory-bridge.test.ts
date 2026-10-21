import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerAgentBridge } from '../electron/agent-bridge';
import { createProjectDirectory } from '../electron/project-directories';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({
	dialog: {},
	ipcMain: {
		handle: (channel: string, handler: (...args: any[]) => unknown) =>
			handlers.set(channel, handler),
	},
}));
vi.mock('../electron/project-directories', () => ({ createProjectDirectory: vi.fn() }));

beforeEach(() => {
	handlers.clear();
	vi.resetAllMocks();
});

describe('project creation IPC boundary', () => {
	it('validates the local renderer before creating a folder and never calls a remote instance', async () => {
		const trusted = {} as IpcMainInvokeEvent;
		const validateSender = vi.fn((event) => {
			if (event !== trusted) throw new Error('Untrusted renderer');
		});
		const remote = vi.fn();
		registerAgentBridge({
			validateSender,
			window: () => null,
			agent: {} as any,
			instances: { tools: remote } as any,
		});
		const handler = handlers.get('freelm:project-create-directory')!;
		expect(() => handler({}, 'Project')).toThrow('Untrusted renderer');
		expect(createProjectDirectory).not.toHaveBeenCalled();
		vi.mocked(createProjectDirectory).mockResolvedValue('/test/Documents/FreeLM/Project');
		await expect(handler(trusted, 'Project')).resolves.toBe('/test/Documents/FreeLM/Project');
		expect(createProjectDirectory).toHaveBeenCalledExactlyOnceWith('Project');
		expect(remote).not.toHaveBeenCalled();
		expect(validateSender).toHaveBeenCalledTimes(2);
	});
});
