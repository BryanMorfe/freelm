import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeComputerAdapter } from '../electron/computer-native';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn(() => true) }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('../electron/computer-linux', () => ({ createLinuxComputerAdapter: vi.fn() }));
function processFixture() {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killed: false,
		exitCode: null,
		signalCode: null,
		kill: vi.fn(),
	});
	child.kill.mockImplementation(() => {
		child.killed = true;
		return true;
	});
	const requests: Record<string, unknown>[] = [];
	child.stdin.on('data', (chunk) => {
		for (const line of chunk.toString().trim().split('\n')) requests.push(JSON.parse(line));
	});
	mocks.spawn.mockReturnValue(child);
	return {
		child,
		requests,
		reply: (value: unknown, id = requests.at(-1)?.id) =>
			child.stdout.write(JSON.stringify({ id, result: value }) + '\n'),
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('native Computer Use bridge', () => {
	const adapters: NativeComputerAdapter[] = [];
	beforeEach(() => {
		mocks.spawn.mockReset();
		mocks.existsSync.mockReturnValue(true);
	});
	afterEach(() => {
		adapters.forEach((adapter) => adapter.close());
		adapters.length = 0;
	});
	const create = (onCursor = vi.fn()) => {
		const adapter = new NativeComputerAdapter({ helperPath: '/fixture/freelm-computer', onCursor });
		adapters.push(adapter);
		return adapter;
	};
	it('serializes requests and preserves split UTF-8 response data', async () => {
		const fixture = processFixture(),
			adapter = create();
		const first = adapter.apps('notes'),
			second = adapter.status();
		await tick();
		expect(fixture.requests).toHaveLength(1);
		const data = Buffer.from(
			JSON.stringify({ id: fixture.requests[0].id, result: [{ id: 'notes', name: 'Notes ✍️' }] }) +
				'\n',
		);
		const split = data.indexOf(Buffer.from('✍')) + 1;
		fixture.child.stdout.write(data.subarray(0, split));
		fixture.child.stdout.write(data.subarray(split));
		await expect(first).resolves.toEqual([{ id: 'notes', name: 'Notes ✍️' }]);
		await tick();
		expect(fixture.requests).toHaveLength(2);
		fixture.reply({ available: true });
		await expect(second).resolves.toEqual({ available: true });
		expect(mocks.spawn).toHaveBeenCalledWith(
			'/fixture/freelm-computer',
			[],
			expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
		);
	});
	it('kills active native work on cancellation and does not send queued actions', async () => {
		const fixture = processFixture(),
			adapter = create(),
			controller = new AbortController();
		const active = adapter.snapshot('notes', controller.signal).catch((error) => error);
		const queued = adapter
			.act('notes', 'frame', { type: 'type', text: 'never type' }, controller.signal)
			.catch((error) => error);
		await tick();
		controller.abort();
		expect((await active).message).toContain('stopped');
		expect((await queued).message).toContain('stopped');
		expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(fixture.requests).toHaveLength(1);
	});
	it('invalidates queued work when the adapter closes without a signal', async () => {
		const fixture = processFixture(),
			adapter = create();
		const first = adapter.snapshot('notes').catch((error) => error);
		const queued = adapter
			.act('notes', 'frame', { type: 'type', text: 'never type' })
			.catch((error) => error);
		await tick();
		adapter.close();
		expect((await first).message).toContain('stopped');
		expect((await queued).message).toContain('stopped');
		expect(fixture.requests).toHaveLength(1);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
	});
	it('hard-kills a native helper that does not acknowledge cancellation', async () => {
		vi.useFakeTimers();
		try {
			const fixture = processFixture(),
				adapter = create();
			const pending = adapter.snapshot('notes').catch((error) => error);
			await Promise.resolve();
			adapter.close();
			await pending;
			expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM');
			await vi.advanceTimersByTimeAsync(150);
			expect(fixture.child.kill).toHaveBeenLastCalledWith('SIGKILL');
		} finally {
			vi.useRealTimers();
		}
	});
	it('rejects mismatched protocol responses rather than attributing them to a request', async () => {
		const fixture = processFixture(),
			adapter = create();
		const pending = adapter.snapshot('notes').catch((error) => error);
		await tick();
		fixture.reply({}, 'foreign');
		expect((await pending).message).toContain('did not match');
		expect(fixture.child.kill).toHaveBeenCalled();
	});
	it('bounds native output and exposes helper errors', async () => {
		const fixture = processFixture(),
			adapter = create();
		const pending = adapter.snapshot('notes').catch((error) => error);
		await tick();
		fixture.child.stdout.write(Buffer.alloc(4_000_001));
		expect((await pending).message).toContain('response limit');
	});
	it('only forwards a validated current-app cursor event and hides it on close', async () => {
		const fixture = processFixture(),
			cursor = vi.fn(),
			adapter = create(cursor);
		const pending = adapter.act('notes', 'frame', { type: 'click', x: 10, y: 10 });
		await tick();
		fixture.child.stdout.write(
			JSON.stringify({ event: 'cursor', appId: 'other', x: 10, y: 20, visible: true }) + '\n',
		);
		expect(cursor).not.toHaveBeenCalled();
		fixture.child.stdout.write(
			JSON.stringify({ event: 'cursor', appId: 'notes', x: 10, y: 20, visible: true }) + '\n',
		);
		expect(cursor).toHaveBeenCalledWith({ appId: 'notes', x: 10, y: 20, visible: true });
		fixture.reply(null);
		await pending;
		adapter.close();
		expect(cursor).toHaveBeenLastCalledWith({ appId: 'notes', x: 10, y: 20, visible: false });
	});
	it('rejects idle movement but accepts a focus-loss hide for the current app', async () => {
		const fixture = processFixture(),
			cursor = vi.fn(),
			adapter = create(cursor);
		const emit = (event: Record<string, unknown>) =>
			fixture.child.stdout.write(JSON.stringify({ event: 'cursor', ...event }) + '\n');
		const pending = adapter.act('notes', 'frame', { type: 'click', x: 10, y: 10 });
		await tick();
		emit({ appId: 'notes', x: 10, y: 20, visible: true, animate: false });
		expect(cursor).toHaveBeenLastCalledWith({
			appId: 'notes',
			x: 10,
			y: 20,
			visible: true,
			animate: false,
		});
		fixture.reply(null);
		await pending;
		emit({ appId: 'notes', x: 30, y: 40, visible: true });
		emit({ appId: 'safari', x: 0, y: 0, visible: false });
		expect(cursor).toHaveBeenCalledTimes(1);
		emit({ appId: 'notes', x: 10, y: 20, visible: false });
		expect(cursor).toHaveBeenCalledTimes(2);
		expect(cursor).toHaveBeenLastCalledWith({ appId: 'notes', x: 10, y: 20, visible: false });
		emit({ appId: 'notes', x: 30, y: 40, visible: true });
		expect(cursor).toHaveBeenCalledTimes(2);
	});
	it('hides the pointer on an action error and rejects unsolicited later movement', async () => {
		const fixture = processFixture(),
			cursor = vi.fn(),
			adapter = create(cursor);
		const pending = adapter
			.act('notes', 'frame', { type: 'click', x: 10, y: 10 })
			.catch((error) => error);
		await tick();
		fixture.child.stdout.write(
			JSON.stringify({ event: 'cursor', appId: 'notes', x: 10, y: 20, visible: true }) + '\n',
		);
		fixture.child.stdout.write(
			JSON.stringify({ id: fixture.requests[0].id, error: 'Target is no longer frontmost' }) + '\n',
		);
		expect((await pending).message).toContain('no longer frontmost');
		expect(cursor).toHaveBeenLastCalledWith({ appId: 'notes', x: 10, y: 20, visible: false });
		fixture.child.stdout.write(
			JSON.stringify({ event: 'cursor', appId: 'notes', x: 10, y: 20, visible: true }) + '\n',
		);
		expect(cursor).toHaveBeenCalledTimes(2);
	});
	it('hides the previous app pointer on app switches and only accepts the newly pending app', async () => {
		const fixture = processFixture(),
			cursor = vi.fn(),
			adapter = create(cursor);
		const emit = (appId: string) =>
			fixture.child.stdout.write(
				JSON.stringify({ event: 'cursor', appId, x: 10, y: 20, visible: true }) + '\n',
			);
		const first = adapter.act('notes', 'frame', { type: 'click', x: 10, y: 10 });
		await tick();
		emit('notes');
		fixture.reply(null);
		await first;
		const second = adapter.open('safari');
		expect(cursor).toHaveBeenLastCalledWith({ appId: 'notes', x: 10, y: 20, visible: false });
		await tick();
		emit('notes');
		expect(cursor).toHaveBeenCalledTimes(2);
		emit('safari');
		expect(cursor).toHaveBeenLastCalledWith({ appId: 'safari', x: 10, y: 20, visible: true });
		fixture.reply(null);
		await second;
	});
	it('refreshes a previously denied permission probe in an idle helper only', async () => {
		const first = processFixture(),
			adapter = create();
		const status = adapter.status();
		await tick();
		first.reply({ available: true, accessibility: false, screenRecording: false });
		await status;
		const snapshot = adapter.snapshot('notes');
		await tick();
		const second = processFixture();
		const refresh = adapter.status();
		await tick();
		expect(first.child.kill).not.toHaveBeenCalled();
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		first.reply({ frameId: 'frame' });
		await snapshot;
		await tick();
		expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(second.requests[0].method).toBe('status');
		second.reply({ available: true, accessibility: true, screenRecording: true });
		await refresh;
		const stable = adapter.status();
		await tick();
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		second.reply({ available: true, accessibility: true, screenRecording: true });
		await stable;
	});
	it('does not request OS permission while checking status', async () => {
		const fixture = processFixture(),
			adapter = create();
		const pending = adapter.status();
		await tick();
		expect(fixture.requests[0].method).toBe('status');
		fixture.reply({ available: true, accessibility: false, screenRecording: false });
		await pending;
		const setup = adapter.requestPermissions();
		await tick();
		expect(fixture.requests[1].method).toBe('request_permissions');
		fixture.reply({ available: true });
		await setup;
	});
	it('preserves environment diagnostics and does not recycle an allowed helper for a locked screen', async () => {
		const fixture = processFixture(),
			adapter = create();
		const locked = {
			platform: 'darwin',
			available: true,
			accessibility: true,
			screenRecording: true,
			screenLocked: true,
			sessionActive: true,
			displaysAwake: false,
			message:
				'The Mac is locked. Unlock it, then observe the authorized app again. No input was sent.',
		};
		const status = adapter.status();
		await tick();
		fixture.reply(locked);
		await expect(status).resolves.toEqual(locked);
		const refresh = adapter.status();
		await tick();
		expect(fixture.requests.map((request) => request.method)).toEqual(['status', 'status']);
		expect(fixture.child.kill).not.toHaveBeenCalled();
		const unknownEnvironment = {
			platform: 'darwin',
			available: true,
			accessibility: true,
			screenRecording: true,
		};
		fixture.reply(unknownEnvironment);
		await expect(refresh).resolves.toEqual(unknownEnvironment);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
	});
	it('reports a missing helper as unavailable without launching anything', async () => {
		mocks.existsSync.mockReturnValue(false);
		await expect(create().status()).resolves.toMatchObject({
			available: false,
			message: expect.stringContaining('missing'),
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
