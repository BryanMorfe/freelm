import { describe, expect, it, vi } from 'vitest';
import { SearchController } from '../electron/search-controller';
import type { SearchServiceStatus, ToolSettings } from '../src/agent-types';
import { defaultSearchSettings, normalizedSearchSettings } from '../src/lib/search-settings';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { validateToolSettings } from '../electron/agent-validation';

function fixture() {
	let settings: ToolSettings['webBrowsing'] = defaultSearchSettings();
	let status: SearchServiceStatus = { phase: 'stopped', engines: [], selectedEngineNames: [] };
	const manager = {
		status: () => status,
		start: vi.fn(async (engines: string[]) => {
			status = {
				...status,
				phase: 'running',
				url: 'http://127.0.0.1:12345',
				selectedEngineNames: engines,
			};
			return status;
		}),
		restart: vi.fn(async (engines: string[]) => {
			status = {
				...status,
				phase: 'running',
				url: 'http://127.0.0.1:12346',
				selectedEngineNames: engines,
			};
			return status;
		}),
		stop: vi.fn(async () => {
			status = { ...status, phase: 'stopped', url: undefined };
			return status;
		}),
		close: vi.fn(async () => {}),
	};
	const controller = new SearchController(manager, async () => structuredClone(settings));
	return {
		manager,
		controller,
		set: (next: ToolSettings['webBrowsing']) => {
			settings = next;
		},
	};
}

describe('saved host search configuration', () => {
	it('keeps legacy external URLs and leaves the original configuration unchanged', async () => {
		const old = { enabled: true, searxngUrl: 'http://192.168.0.221:18991' };
		const copy = structuredClone(old);
		expect(normalizedSearchSettings(old)).toMatchObject({
			mode: 'external',
			autoStart: false,
			...old,
		});
		expect(old).toEqual(copy);
		const { controller, manager, set } = fixture();
		set(old);
		await controller.update();
		expect(manager.start).not.toHaveBeenCalled();
		expect(controller.resolve(old)).toBe('http://192.168.0.221:18991/search');
		await controller.update();
		expect(manager.stop).toHaveBeenCalledTimes(1);
	});
	it('starts only an enabled built-in profile with auto-start and honors manual Stop', async () => {
		const { controller, manager, set } = fixture();
		set({ ...defaultSearchSettings(), enabled: true, autoStart: true });
		await controller.update();
		expect(manager.start).toHaveBeenCalledTimes(1);
		await controller.stop();
		await controller.update();
		expect(manager.start).toHaveBeenCalledTimes(1);
		expect(controller.status().phase).toBe('stopped');
		await controller.start();
		expect(manager.start).toHaveBeenCalledTimes(2);
	});
	it('applies engine changes once to a running service and stops after switching to external', async () => {
		const { controller, manager, set } = fixture();
		const initial = { ...defaultSearchSettings(), enabled: true };
		set(initial);
		await controller.update();
		expect(manager.start).not.toHaveBeenCalled();
		await controller.start();
		set({ ...initial, engines: ['bing'] });
		await controller.update();
		await controller.update();
		expect(manager.restart).toHaveBeenCalledExactlyOnceWith(['bing']);
		set({ ...initial, mode: 'external', searxngUrl: 'https://search.example' });
		await controller.update();
		expect(controller.status().phase).toBe('stopped');
	});
	it('does not retry failed automatic starts on unrelated workspace saves', async () => {
		const { controller, manager, set } = fixture();
		set({ ...defaultSearchSettings(), enabled: true, autoStart: true });
		manager.start.mockRejectedValueOnce(new Error('Runtime failed.'));
		await expect(controller.update()).rejects.toThrow('Runtime failed.');
		await controller.update();
		expect(manager.start).toHaveBeenCalledTimes(1);
	});
	it('interrupts an in-flight start instead of queuing Stop behind readiness', async () => {
		const { controller, manager } = fixture();
		let rejectStart: (error: Error) => void = () => {};
		manager.start.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectStart = reject;
				}),
		);
		const start = controller.start();
		await vi.waitFor(() => expect(manager.start).toHaveBeenCalled());
		manager.stop.mockImplementationOnce(async () => {
			rejectStart(new Error('Startup cancelled.'));
			return { phase: 'stopped', engines: [], selectedEngineNames: [] };
		});
		const rejected = expect(start).rejects.toThrow('Startup cancelled.');
		await controller.stop();
		await rejected;
	});
	it.each(['disabled', 'external'] as const)(
		'cancels a stalled automatic startup immediately after saving %s browsing',
		async (change) => {
			const { controller, manager, set } = fixture();
			const initial = { ...defaultSearchSettings(), enabled: true, autoStart: true };
			set(initial);
			let finishStart: (status: SearchServiceStatus) => void = () => {};
			manager.start.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishStart = resolve;
					}),
			);
			const automaticStart = controller.update();
			await vi.waitFor(() => expect(manager.start).toHaveBeenCalledTimes(1));
			const originalStop = manager.stop.getMockImplementation()!;
			manager.stop.mockImplementationOnce(async () => {
				const stopped = await originalStop();
				finishStart(stopped);
				return stopped;
			});
			set(
				change === 'disabled'
					? { ...initial, enabled: false }
					: { ...initial, mode: 'external', searxngUrl: 'https://search.example' },
			);
			const savedChange = controller.update();
			await vi.waitFor(() => expect(manager.stop).toHaveBeenCalledTimes(1));
			await Promise.all([automaticStart, savedChange]);
			expect(controller.status().phase).toBe('stopped');
			await controller.update();
			expect(manager.start).toHaveBeenCalledTimes(1);
			set(initial);
			await controller.update();
			expect(manager.start).toHaveBeenCalledTimes(2);
		},
	);

	it.each(['disabled', 'external'] as const)(
		'cancels a stalled manual startup immediately after saving %s browsing',
		async (change) => {
			const { controller, manager, set } = fixture();
			const initial = { ...defaultSearchSettings(), enabled: true };
			set(initial);
			await controller.update();
			let finishStart: (status: SearchServiceStatus) => void = () => {};
			manager.start.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishStart = resolve;
					}),
			);
			const manualStart = controller.start();
			await vi.waitFor(() => expect(manager.start).toHaveBeenCalledTimes(1));
			const originalStop = manager.stop.getMockImplementation()!;
			manager.stop.mockImplementationOnce(async () => {
				const stopped = await originalStop();
				finishStart(stopped);
				return stopped;
			});
			set(
				change === 'disabled'
					? { ...initial, enabled: false }
					: { ...initial, mode: 'external', searxngUrl: 'https://search.example' },
			);
			const savedChange = controller.update();
			await vi.waitFor(() => expect(manager.stop).toHaveBeenCalledTimes(1));
			await Promise.all([manualStart, savedChange]);
			expect(controller.status().phase).toBe('stopped');
			expect(manager.start).toHaveBeenCalledTimes(1);
		},
	);
	it('invalidates a queued manual Start when saved browsing is disabled', async () => {
		const { controller, manager, set } = fixture();
		const initial = { ...defaultSearchSettings(), enabled: true };
		set(initial);
		await controller.update();
		let finishStart: (status: SearchServiceStatus) => void = () => {};
		manager.start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishStart = resolve;
				}),
		);
		const firstStart = controller.start();
		await vi.waitFor(() => expect(manager.start).toHaveBeenCalledTimes(1));
		const queuedStart = controller.start();
		const originalStop = manager.stop.getMockImplementation()!;
		manager.stop.mockImplementationOnce(async () => {
			const stopped = await originalStop();
			finishStart(stopped);
			return stopped;
		});
		set({ ...initial, enabled: false });
		await Promise.all([firstStart, queuedStart, controller.update()]);
		expect(manager.start).toHaveBeenCalledTimes(1);
		expect(controller.status().phase).toBe('stopped');
	});

	it('uses only the current host-owned loopback endpoint for built-in requests', async () => {
		const { controller } = fixture();
		const config = {
			...defaultSearchSettings(),
			enabled: true,
			searxngUrl: 'http://ignored.invalid',
		};
		expect(() => controller.resolve(config)).toThrow('Start the built-in');
		await controller.start();
		expect(controller.resolve(config)).toBe('http://127.0.0.1:12345');
		await controller.stop();
		expect(() => controller.resolve(config)).toThrow('Start the built-in');
	});
	it('requires a configured engine for enabled built-in browsing, while preserving external settings', () => {
		const tools = defaultToolSettings();
		tools.webBrowsing = { ...defaultSearchSettings(), enabled: true };
		expect(() => validateToolSettings(tools)).not.toThrow();
		tools.webBrowsing.engines = [];
		expect(() => validateToolSettings(tools)).toThrow('at least one');
		tools.webBrowsing = { enabled: true, searxngUrl: 'https://search.example' };
		expect(() => validateToolSettings(tools)).not.toThrow();
		tools.webBrowsing = { ...defaultSearchSettings(), engines: ['bing', 'bing'] };
		expect(() => validateToolSettings(tools)).toThrow('Invalid web');
	});
	it('rejects new lifecycle work after shutdown', async () => {
		const { controller, manager } = fixture();
		await controller.close();
		expect(manager.close).toHaveBeenCalledTimes(1);
		await expect(controller.start()).rejects.toThrow('shutting down');
	});
});
