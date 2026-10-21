import { describe, expect, it, vi } from 'vitest';
import { LinuxComputerAdapter } from '../electron/computer-linux';

// Minimal JPEG metadata fixture. Production receives ImageMagick's complete JPEG.
function jpeg(width = 1000, height = 500) {
	const value = Buffer.from([
		0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
	]);
	value.writeUInt16BE(height, 7);
	value.writeUInt16BE(width, 9);
	return value;
}

function fixture() {
	const state = {
		active: '42',
		windows: '0x0000002a 0 99 10 20 2000 1000 editor.Editor workstation A document\n',
		started: '1000',
		now: 100,
		image: jpeg(),
		failCommand: undefined as string | undefined,
		afterCommand: undefined as ((args: string[]) => void) | undefined,
	};
	const onCursor = vi.fn();
	const run = vi.fn(
		async (_file: string, args: string[], signal?: AbortSignal): Promise<Buffer> => {
			if (signal?.aborted) throw new Error('Aborted');
			if (args[0] === '-lpGx') return Buffer.from(state.windows);
			if (args[0] === 'getactivewindow') return Buffer.from(state.active);
			if (args.includes('jpeg:-')) return state.image;
			if (args[0] === state.failCommand) throw new Error('Input unavailable');
			state.afterCommand?.(args);
			return Buffer.alloc(0);
		},
	);
	const processIdentity = vi.fn(async (pid: number) => {
		if (pid === 666) throw new Error('Missing process');
		return { executable: '/usr/bin/editor', started: state.started };
	});
	const adapter = new LinuxComputerAdapter({
		onCursor,
		dependencies: {
			env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
			executable: async () => true,
			run,
			processIdentity,
			now: () => state.now,
		},
	});
	async function observe() {
		const app = (await adapter.apps(''))[0];
		await adapter.open(app.id);
		return { app, frame: await adapter.snapshot(app.id) };
	}
	return { adapter, state, run, onCursor, processIdentity, observe };
}

describe('Linux Computer Use capability and identity', () => {
	it('reports Wayland and missing dependencies without running capture or input', async () => {
		const run = vi.fn();
		const wayland = new LinuxComputerAdapter({
			dependencies: { env: { DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' }, run },
		});
		expect(await wayland.status()).toMatchObject({
			available: false,
			platform: 'linux',
			message: expect.stringContaining('Wayland'),
		});
		await expect(wayland.apps('')).rejects.toThrow('Wayland');
		const missing = new LinuxComputerAdapter({
			dependencies: { env: { DISPLAY: ':0' }, executable: async () => false, run },
		});
		expect(await missing.status()).toMatchObject({
			available: false,
			message: expect.stringContaining('xdotool, wmctrl, and ImageMagick'),
		});
		expect(run).not.toHaveBeenCalled();
	});
	it('lists only process-verified running windows and separates apps sharing an executable', async () => {
		const f = fixture();
		f.state.windows += '0x0000002b 0 99 10 20 1000 500 browser.Browser workstation A browser\n';
		f.state.windows += '0x0000002c 0 666 10 20 1000 500 fake.Fake workstation Missing\n';
		f.state.windows +=
			'0x0000002d 0 99 10 20 1000 500 editor.Editor workstation Another document\n';
		const apps = await f.adapter.apps('');
		expect(apps.map((app) => app.name)).toEqual(['Browser', 'Editor']);
		expect(new Set(apps.map((app) => app.id)).size).toBe(2);
		expect(f.processIdentity.mock.calls.filter(([pid]) => pid === 99)).toHaveLength(1);
		expect(await f.adapter.apps('edit')).toEqual([apps[1]]);
	});
	it('does not open an undiscovered identity or launch arbitrary executables', async () => {
		const f = fixture();
		await expect(f.adapter.open('/bin/sh')).rejects.toThrow('discovery');
		expect(f.run).not.toHaveBeenCalled();
		await f.observe();
		expect(
			f.run.mock.calls.every(([file]) =>
				['/usr/bin/xdotool', '/usr/bin/wmctrl', '/usr/bin/import'].includes(file),
			),
		).toBe(true);
		expect(
			f.run.mock.calls.some(([, args]) => args[0] === 'windowactivate' && args[2] === '42'),
		).toBe(false);
	});
	it('excludes FreeLM and system-settings windows from app authorization targets', async () => {
		const f = fixture();
		f.state.windows =
			`0x0000002a 0 ${process.pid} 10 20 2000 1000 editor.Editor workstation Own process\n` +
			'0x0000002b 0 99 10 20 2000 1000 freelm.FreeLM workstation FreeLM\n' +
			'0x0000002c 0 99 10 20 2000 1000 gnome-control-center.Gnome-control-center workstation Settings\n';
		expect(await f.adapter.apps('')).toEqual([]);
	});
});

describe('Linux background observations and independent input capabilities', () => {
	it('captures the selected client window without raising it or reading the desktop', async () => {
		const f = fixture();
		f.state.active = '43';
		const { app, frame } = await f.observe();
		expect(frame.image).toMatchObject({ width: 1000, height: 500 });
		expect(frame.window).toEqual({
			id: '42',
			title: 'A document',
			bounds: { x: 10, y: 20, width: 2000, height: 1000 },
		});
		const capture = f.run.mock.calls.find(([file]) => file.endsWith('/import'))![1];
		expect(capture).toContain('1440x1440>');
		expect(capture.slice(capture.indexOf('-window'), capture.indexOf('-window') + 2)).toEqual([
			'-window',
			'42',
		]);
		expect(capture).not.toContain('root');
		expect(frame.notices?.join(' ')).toContain('Pointer actions');
		expect((await f.adapter.status()).message).toContain('Independent pointer input');
		await f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' });
		expect(f.state.active).toBe('43');
		expect(
			f.run.mock.calls.some(([, args]) =>
				['windowactivate', 'windowfocus', 'getactivewindow'].includes(args[0]),
			),
		).toBe(false);
	});
	it('targets typing and keyboard events at the approved window while the user works elsewhere', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		f.state.active = '43';
		await f.adapter.act(app.id, frame.frameId, { type: 'type', text: 'Hello' });
		f.state.active = '44';
		const next = await f.adapter.snapshot(app.id);
		await f.adapter.act(app.id, next.frameId, {
			type: 'key',
			key: 'Enter',
			modifiers: ['ctrl', 'shift'],
		});
		expect(
			f.run.mock.calls
				.filter(([, args]) => ['type', 'key'].includes(args[0]))
				.map(([, args]) => args),
		).toEqual([
			['type', '--window', '42', '--delay', '0', '--', 'Hello'],
			['key', '--window', '42', 'ctrl+shift+Return'],
		]);
		expect(
			f.run.mock.calls.some(
				([, args]) =>
					args.includes('--clearmodifiers') ||
					['windowactivate', 'windowfocus', 'mousemove', 'mousedown', 'mouseup'].includes(args[0]),
			),
		).toBe(false);
		expect(f.onCursor).not.toHaveBeenCalled();
	});
	it.each([
		{ type: 'click', x: 250, y: 125 },
		{ type: 'double_click', x: 250, y: 125 },
		{ type: 'scroll', x: 250, y: 125, deltaX: 0, deltaY: 120 },
		{ type: 'drag', x: 250, y: 125, toX: 300, toY: 200 },
	] as const)(
		'rejects $type before moving the real pointer and leaves its frame usable',
		async (action) => {
			const f = fixture();
			const { app, frame } = await f.observe();
			f.run.mockClear();
			await expect(f.adapter.act(app.id, frame.frameId, action)).rejects.toThrow(
				'Independent pointer input is unavailable',
			);
			expect(f.run.mock.calls.every(([file]) => file.endsWith('/wmctrl'))).toBe(true);
			expect(f.onCursor).not.toHaveBeenCalled();
			await f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Tab' });
			expect(f.run.mock.calls.find(([, args]) => args[0] === 'key')?.[1]).toEqual([
				'key',
				'--window',
				'42',
				'Tab',
			]);
		},
	);
	it('rejects old, superseded, moved, missing and restarted-process frames before input', async () => {
		for (const reason of ['expired', 'superseded', 'moved', 'missing', 'restarted'] as const) {
			const f = fixture();
			const { app, frame } = await f.observe();
			if (reason === 'expired') f.state.now += 300_001;
			if (reason === 'superseded') await f.adapter.snapshot(app.id);
			if (reason === 'moved') f.state.windows = f.state.windows.replace('10 20 2000', '11 20 2000');
			if (reason === 'missing') f.state.windows = '';
			if (reason === 'restarted') f.state.started = '1001';
			f.run.mockClear();
			await expect(
				f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' }),
			).rejects.toThrow();
			expect(
				f.run.mock.calls.some(([, args]) =>
					['click', 'mousemove', 'type', 'key'].includes(args[0]),
				),
			).toBe(false);
		}
	});
	it('checks window identity after capture and invalidates prior frames when capture fails', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		const run = f.run.getMockImplementation()!;
		f.run.mockImplementation(async (file, args, signal) => {
			const result = await run(file, args, signal);
			if (args.includes('jpeg:-'))
				f.state.windows = f.state.windows.replace('10 20 2000', '11 20 2000');
			return result;
		});
		await expect(f.adapter.snapshot(app.id)).rejects.toThrow('changed while capturing');
		f.state.windows = f.state.windows.replace('11 20 2000', '10 20 2000');
		await expect(
			f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' }),
		).rejects.toThrow('stale');
	});
	it('rejects screenshot data exceeding size or dimension bounds', async () => {
		for (const image of [
			jpeg(1441, 600),
			Buffer.alloc(4 * 1024 * 1024 + 1),
			Buffer.from('not an image'),
		]) {
			const f = fixture();
			f.state.image = image;
			await expect(f.observe()).rejects.toThrow();
		}
	});
	it('passes text as one literal argument and explicitly targets the verified window', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		const text = '--window root $(touch /tmp/unwanted); `exit`\nText';
		await f.adapter.act(app.id, frame.frameId, { type: 'type', text });
		expect(f.run.mock.calls.find(([, args]) => args[0] === 'type')?.[1]).toEqual([
			'type',
			'--window',
			'42',
			'--delay',
			'0',
			'--',
			text,
		]);
	});
	it('validates keyboard arguments and rejects unavailable element actions without sending input', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		const invalid = [
			{ type: 'key', key: 'windowkill' },
			{ type: 'key', key: 'a', modifiers: ['invalid'] },
			{ type: 'type', text: '\0' },
			{ type: 'type', text: 'x'.repeat(16_385) },
			{ type: 'press', elementId: 'fake' },
			{ type: 'select', elementId: 'fake' },
			{ type: 'set_value', elementId: 'fake', text: 'hello' },
		] as const;
		for (const action of invalid)
			await expect(f.adapter.act(app.id, frame.frameId, action as never)).rejects.toThrow();
		expect(
			f.run.mock.calls.some(([, args]) => ['click', 'mousemove', 'type', 'key'].includes(args[0])),
		).toBe(false);
		await f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' });
	});
	it('consumes the frame after attempted input fails without falling back or retrying', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		f.state.failCommand = 'key';
		await expect(
			f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' }),
		).rejects.toThrow('Input unavailable');
		await expect(
			f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' }),
		).rejects.toThrow('stale');
		expect(f.run.mock.calls.filter(([, args]) => args[0] === 'key')).toHaveLength(1);
		expect(
			f.run.mock.calls.some(([, args]) => ['windowactivate', 'windowfocus'].includes(args[0])),
		).toBe(false);
	});
	it('stops on cancellation and invalidates the adapter on close', async () => {
		const f = fixture();
		const { app, frame } = await f.observe();
		const abort = new AbortController();
		abort.abort(new Error('User stopped'));
		await expect(
			f.adapter.act(app.id, frame.frameId, { type: 'key', key: 'Enter' }, abort.signal),
		).rejects.toThrow('User stopped');
		f.adapter.close();
		await expect(f.adapter.apps('')).rejects.toThrow('stopped');
		expect(f.run.mock.calls.some(([, args]) => args[0] === 'key')).toBe(false);
	});
});
