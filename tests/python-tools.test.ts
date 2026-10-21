import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PythonRuntime, macPythonProfile } from '../electron/tools/python';
import { configuredPython, pythonTool } from '../src/lib/python-tools';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { validateToolSettings, validToolRecords } from '../electron/agent-validation';
import { machineIndependentTools, assertChatToolCall } from '../src/lib/conversation-tools';
import { AgentHost } from '../electron/agent-host';
import { initialState } from '../src/lib/state';
import { chatPromptCatalog, buildSystemPrompt } from '../src/lib/system-prompt';
import type { ToolHostRequest, ToolResult } from '../src/agent-types';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
const request = (code: string, overrides: Partial<ToolHostRequest> = {}): ToolHostRequest => ({
	workspaceId: 'local',
	runId: 'run-a',
	threadId: 'thread-a',
	name: pythonTool.name,
	arguments: { code },
	...overrides,
});
const text = (result: ToolResult) =>
	result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');
const runtime = (options: ConstructorParameters<typeof PythonRuntime>[0] = {}) => {
	const value = new PythonRuntime({
		...(process.env.FREELM_PYTHON_TEST_EXECUTABLE
			? { executablePath: process.env.FREELM_PYTHON_TEST_EXECUTABLE }
			: {}),
		...options,
	});
	cleanups.push(() => value.close());
	return value;
};

describe('Chat Python configuration and boundary', () => {
	it('offers only machine-independent tools for temporary Chat without creating a saved thread', async () => {
		const state = initialState();
		state.threads = [];
		state.toolSettings = {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: true,
			workspaceRoot: tmpdir(),
			pythonExecution: { enabled: true },
			mcpServers: [
				{
					id: 'server',
					name: 'Must not start',
					enabled: true,
					transport: 'stdio',
					command: '/must-not-run',
				},
			],
			skillDirectories: ['/must-not-read'],
		};
		const host = new AgentHost(
			async () => structuredClone(state),
			async () => {
				throw new Error('Chat must not request local execution approvals.');
			},
		);
		cleanups.push(() => host.close());
		const execute = vi
			.spyOn(PythonRuntime.prototype, 'execute')
			.mockResolvedValue({ content: [{ type: 'text', text: '2' }] });
		const catalog = await host.catalog('temporary-run', 'temporary-thread', false, true);
		expect(catalog.tools.map((tool) => tool.name)).toEqual(['python.exec']);
		expect(state.threads).toEqual([]);
		expect(
			await host.execute(request('1+1', { runId: 'temporary-run', threadId: 'temporary-thread' })),
		).toEqual({ content: [{ type: 'text', text: '2' }] });
		expect(execute).toHaveBeenCalledOnce();
		await expect(
			host.execute(
				request('1', {
					runId: 'temporary-run',
					threadId: 'temporary-thread',
					name: 'exec_command',
					arguments: { cmd: 'false' },
				}),
			),
		).rejects.toThrow('only in Code');
		expect(chatPromptCatalog(state).tools.some((tool) => tool.name === 'python.exec')).toBe(true);
		expect(
			buildSystemPrompt({
				state,
				kind: 'chat',
				thread: { id: 'temporary-thread' },
				memorySupported: false,
			}).text,
		).toContain('isolated Python interpreter');
	});
	it('is explicitly enabled and stays separate from Code commands', () => {
		const settings = defaultToolSettings();
		expect(configuredPython(settings)).toBe(false);
		settings.enabled = true;
		settings.commandExecution = true;
		expect(configuredPython(settings)).toBe(false);
		settings.pythonExecution = { enabled: true };
		expect(configuredPython(settings)).toBe(true);
		expect(() => validateToolSettings(settings)).not.toThrow();
		expect(() =>
			validateToolSettings({
				...settings,
				pythonExecution: { enabled: true, executable: '/bin/sh' },
			}),
		).toThrow('Invalid Python');
		expect(machineIndependentTools([pythonTool, { ...pythonTool, name: 'exec_command' }])).toEqual([
			pythonTool,
		]);
		expect(() => assertChatToolCall(pythonTool.name, { code: '1 + 1' })).not.toThrow();
		expect(() => assertChatToolCall('exec_command', {})).toThrow('only in Code');
	});
	it('has a default-deny macOS profile with no home/network/command grant', () => {
		const profile = macPythonProfile('/runtime/bin/python3', '/runtime', '/private/tmp/session');
		expect(profile).toContain('(deny default)');
		expect(profile).not.toContain('(allow network');
		expect(profile).not.toContain('(allow process-fork');
		expect(profile).not.toContain(homedir());
		expect(profile).toContain('(allow process-exec (literal "/runtime/bin/python3"))');
		expect(profile).toContain('(subpath "/private/tmp/session/output")');
	});
	it('fails closed when isolation is unavailable', async () => {
		const value = runtime({ isolationExecutable: '/nonexistent/freelm-isolation' });
		await expect(
			value.execute(request('print("must not execute")'), new AbortController().signal),
		).rejects.toThrow(/sandbox|bubblewrap/);
	});
	it('rejects unsupported arguments before creating an interpreter', async () => {
		const value = runtime({ isolationExecutable: '/nonexistent/freelm-isolation' });
		await expect(
			value.execute(
				request('1', { arguments: { code: '1', executable: '/bin/sh' } }),
				new AbortController().signal,
			),
		).rejects.toThrow('Unsupported Python');
		await expect(
			value.execute(
				request('1', { arguments: { code: '1', timeout_ms: 120001 } }),
				new AbortController().signal,
			),
		).rejects.toThrow('timeout_ms');
	});
	it('accepts portable file outputs in persisted tool records', () => {
		expect(
			validToolRecords([
				{
					id: 'call',
					name: 'python.exec',
					arguments: '{}',
					status: 'completed',
					startedAt: 1,
					result: {
						content: [
							{
								type: 'file',
								name: 'data.csv',
								mimeType: 'text/csv',
								dataUrl: 'data:text/csv;base64,eA==',
							},
						],
					},
				},
			]),
		).toBe(true);
	});
});

// Real OS checks are opt-in because macOS sandbox-exec cannot nest inside the
// coding agent's own sandbox. Run this suite on the desktop host to verify it.
describe.skipIf(process.env.FREELM_NATIVE_PYTHON_SANDBOX !== '1')(
	'native Chat Python isolation',
	() => {
		it('retains variables within a thread, separates threads, returns files, and denies host reads/network/commands', async () => {
			const value = runtime();
			const signal = new AbortController().signal;
			expect(text(await value.execute(request('answer = 41\nanswer + 1'), signal))).toContain('42');
			expect(
				text(await value.execute(request('answer + 2', { runId: 'run-b' }), signal)),
			).toContain('43');
			expect(
				(await value.execute(request('answer', { threadId: 'thread-b' }), signal)).isError,
			).toBe(true);
			const created = await value.execute(
				request(
					"from pathlib import Path\nPath('result.csv').write_text('a,b\\n1,2\\n')\nprint('saved')",
				),
				signal,
			);
			const file = created.content.find((item) => item.type === 'file');
			expect(file).toMatchObject({ type: 'file', name: 'result.csv', mimeType: 'text/csv' });
			if (file?.type === 'file')
				expect(Buffer.from(file.dataUrl.split(',')[1], 'base64').toString()).toBe('a,b\n1,2\n');
			expect(
				(await value.execute(request('answer'), signal)).content.some(
					(item) => item.type === 'file',
				),
			).toBe(false);
			const benignHomeFile = path.resolve('package.json');
			await readFile(benignHomeFile);
			const denied = await value.execute(
				request(`open(${JSON.stringify(benignHomeFile)}).close()`),
				signal,
			);
			expect(denied.isError).toBe(true);
			expect(text(denied)).toMatch(/PermissionError|FileNotFoundError/);
			const homeDirectory = await value.execute(
				request(`import os\nos.listdir(${JSON.stringify(homedir())})`),
				signal,
			);
			expect(homeDirectory.isError).toBe(true);
			expect(text(homeDirectory)).toMatch(/PermissionError|FileNotFoundError/);
			const link = await value.execute(
				request(`import os\nos.link(${JSON.stringify(benignHomeFile)}, 'host-link.txt')`),
				signal,
			);
			expect(link.isError).toBe(true);
			expect(
				link.content.some((item) => item.type === 'file' && item.name === 'host-link.txt'),
			).toBe(false);
			const symlink = await value.execute(
				request(`import os\nos.symlink(${JSON.stringify(benignHomeFile)}, 'symlink.txt')`),
				signal,
			);
			expect(
				symlink.content.some((item) => item.type === 'file' && item.name === 'symlink.txt'),
			).toBe(false);
			const network = await value.execute(
				request("import socket\nsocket.create_connection(('127.0.0.1',9), timeout=1)"),
				signal,
			);
			expect(network.isError).toBe(true);
			expect(text(network)).toContain('PermissionError');
			const command = await value.execute(
				request("import subprocess\nsubprocess.run(['/usr/bin/id'])"),
				signal,
			);
			expect(command.isError).toBe(true);
			expect(text(command)).toContain('PermissionError');
			if (process.platform === 'darwin') {
				// Bypass the CPython audit hook: the kernel sandbox itself must deny fork.
				const nativeFork = await value.execute(
					request(
						'import ctypes\nlibc=ctypes.CDLL(None,use_errno=True)\n(libc.fork(), ctypes.get_errno())',
					),
					signal,
				);
				expect(text(nativeFork)).toContain('(-1, 1)');
			}
		}, 30000);
		it('bounds output, kills timed-out code, and starts a clean interpreter afterwards', async () => {
			const value = runtime();
			const signal = new AbortController().signal;
			const result = await value.execute(request("x=99\nprint('x'*200000)"), signal);
			expect(text(result).length).toBeLessThan(66000);
			expect(text(result)).toContain('[Output truncated.]');
			const emptyWrites = await value.execute(
				request(
					"import sys\ncapture=sys.stdout\ncapture.write('x'*65536)\nfor i in range(100000): capture.write('')\nlen(capture.parts)",
				),
				signal,
			);
			expect(text(emptyWrites)).toContain('Result:\n1');
			await expect(
				value.execute(
					request('while True: pass', { arguments: { code: 'while True: pass', timeout_ms: 100 } }),
					signal,
				),
			).rejects.toThrow(/timed out|reset/);
			expect((await value.execute(request('x'), signal)).isError).toBe(true);
		}, 30000);
		it('resets the interpreter when aggregate output or scratch storage exceeds its quota', async () => {
			const value = runtime({
				maxSessionBytes: 1024 * 1024,
				maxSessionEntries: 16,
				monitorIntervalMs: 20,
			});
			const signal = new AbortController().signal;
			await expect(
				value.execute(
					request(
						"from pathlib import Path\nimport time\nx=123\nPath('oversized.bin').write_bytes(b'x'*2000000)\ntime.sleep(30)",
					),
					signal,
				),
			).rejects.toThrow('storage quota');
			expect((await value.execute(request('x'), signal)).isError).toBe(true);
			await expect(
				value.execute(
					request('from pathlib import Path\nfor i in range(20): Path(str(i)).touch()'),
					signal,
				),
			).rejects.toThrow('storage quota');
			const scratch =
				"from pathlib import Path\nimport sys\nPath(sys.argv[1]).parent.joinpath('scratch', 'large.bin').write_bytes(b'x'*2000000)";
			await expect(value.execute(request(scratch), signal)).rejects.toThrow('storage quota');
		}, 30000);
		it('returns only decoded bounded image previews and keeps invalid or oversized image bytes downloadable', async () => {
			const value = runtime();
			const signal = new AbortController().signal;
			const smallPng =
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
			const result = await value.execute(
				request(
					`from pathlib import Path\nimport base64, struct\nvalid = base64.b64decode('${smallPng}')\nPath('small.png').write_bytes(valid)\nhuge = bytearray(valid)\nhuge[16:24] = struct.pack('>II', 100000, 100000)\nPath('huge.png').write_bytes(huge)\nPath('invalid.png').write_bytes(b'not an image')\nPath('animation.gif').write_bytes(b'GIF89a\\x01\\x00\\x01\\x00')`,
				),
				signal,
			);
			const pixels = result.content.filter((part) => part.type === 'image');
			expect(pixels).toHaveLength(1);
			expect(pixels[0]).toMatchObject({ name: 'small-preview.jpg' });
			if (pixels[0]?.type === 'image')
				expect(pixels[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
			const files = result.content.filter((part) => part.type === 'file');
			expect(files.map((part) => part.type === 'file' && part.name).sort()).toEqual([
				'animation.gif',
				'huge.png',
				'invalid.png',
				'small.png',
			]);
			expect(text(result)).toContain('16 megapixel');
			expect(text(result)).toContain('invalid.png is available for download');
			expect(text(result)).toContain('Inline previews support PNG, JPEG, and WebP only');
		}, 30000);
		it('cancels an active process and cleans the session directory', async () => {
			const directory = await mkdtemp(path.join(tmpdir(), 'freelm-python-test-'));
			cleanups.push(() => rm(directory, { recursive: true, force: true }));
			const value = runtime({ sessionRoot: directory });
			const controller = new AbortController();
			const execution = value.execute(request('import time\ntime.sleep(60)'), controller.signal);
			setTimeout(() => controller.abort(), 150);
			await expect(execution).rejects.toThrow(/cancel|reset|stopped/);
			expect(text(await value.execute(request('1+1'), new AbortController().signal))).toContain(
				'2',
			);
			await value.close();
			expect(await readdir(directory)).toEqual([]);
		}, 30000);
	},
);
