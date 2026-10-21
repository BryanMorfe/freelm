import { cp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

/** Real Electron NSOpenPanel/NSSavePanel regression, with no mocked dialog or input. */
export async function exerciseElectronDialogs(desktop, page, profile) {
	const selectedCase = process.env.FREELM_DIALOG_CASE ?? 'all';
	assert.ok(['all', 'click', 'select', 'save'].includes(selectedCase));
	const root = path.join(profile, 'Electron dialogs');
	const appId = `app.freelm.fixture.dialogs.${randomUUID().replaceAll('-', '')}`;
	const app = path.join(root, 'Dialog Fixture.app');
	await mkdir(path.join(root, 'Files', 'Destination 🧪'), { recursive: true });
	await cp(path.resolve('node_modules/electron/dist/Electron.app'), app, {
		recursive: true,
		verbatimSymlinks: true,
	});
	const infoPath = path.join(app, 'Contents', 'Info.plist');
	const run = promisify(execFile);
	await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', appId, infoPath]);
	await run('/usr/bin/plutil', [
		'-replace',
		'CFBundleName',
		'-string',
		'FreeLM Dialog Fixture',
		infoPath,
	]);
	const source = path.join(app, 'Contents', 'Resources', 'app');
	await mkdir(source, { recursive: true });
	await cp(path.resolve('native/computer-dialog-fixture.cjs'), path.join(source, 'main.cjs'));
	await writeFile(
		path.join(source, 'package.json'),
		JSON.stringify({ name: 'freelm-dialog-fixture', main: 'main.cjs' }),
	);
	await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
	const chosen = path.join(root, 'Files', 'Selected fixture.png');
	const destination = path.join(root, 'Files', 'Destination 🧪');
	await writeFile(
		chosen,
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP5sAAAAASUVORK5CYII=',
			'base64',
		),
	);
	const statePath = path.join(root, 'dialog-state.json');
	const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
	const fixture = spawn(path.join(app, 'Contents', 'MacOS', 'Electron'), ['--fixture-root', root], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let diagnostics = '';
	fixture.stderr.on('data', (chunk) => {
		diagnostics = (diagnostics + chunk).slice(-4000);
	});
	const binding = `nativeDialogFixture_${randomUUID().replaceAll('-', '')}`;
	const backgroundBinding = `nativeDialogBackground_${randomUUID().replaceAll('-', '')}`;
	const hostWindow = await desktop.browserWindow(page);
	const hostWindowId = await hostWindow.evaluate((window) => window.id);
	await page.exposeFunction(backgroundBinding, (bounds) =>
		desktop.evaluate(
			({ app, BrowserWindow, screen }, { hostWindowId, bounds }) => {
				const host = BrowserWindow.fromId(hostWindowId);
				if (!host) throw new Error('Disposable foreground host closed.');
				if (bounds) {
					host.setBounds({
						x: Math.floor(bounds.x - 12),
						y: Math.floor(bounds.y - 12),
						width: Math.ceil(bounds.width + 24),
						height: Math.ceil(bounds.height + 24),
					});
					host.show();
					app.focus({ steal: true });
					host.focus();
				}
				return { focused: host.isFocused(), pointer: screen.getCursorScreenPoint() };
			},
			{ hostWindowId, bounds },
		),
	);
	let sequence = 0;
	await page.exposeFunction(binding, async (kind) => {
		if (kind === 'open' || kind === 'save') {
			await writeFile(
				path.join(root, 'dialog-control.json'),
				JSON.stringify({ sequence: ++sequence, kind }),
			);
		}
		return readState();
	});
	try {
		let ready;
		for (let i = 0; i < 100; i++) {
			if (fixture.exitCode !== null || fixture.signalCode !== null)
				throw new Error(`Dialog fixture exited: ${diagnostics}`);
			try {
				ready = await readState();
			} catch {
				/* First atomic state write. */
			}
			if (ready?.ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready?.ready, `Dialog fixture did not become ready: ${diagnostics}`);
		const report = await page.evaluate(
			async ({ appId, binding, backgroundBinding, chosen, destination, selectedCase }) => {
				const bridge = window.desktop;
				const snapshot = await bridge.workspaceLoad('local');
				const runId = crypto.randomUUID(),
					threadId = crypto.randomUUID();
				snapshot.state.connections = [
					{
						id: 'dialog-fixture',
						name: 'No provider requests',
						baseUrl: 'http://127.0.0.1:9/v1',
						apiKey: '',
						chatApi: 'responses',
						models: { chat: 'fixture', images: '', videos: '', speech: '', transcription: '' },
						discoveredModels: [],
						catalog: [
							{
								id: 'fixture',
								name: 'Fixture',
								enabled: true,
								tasks: ['chat'],
								inputModalities: ['text', 'image'],
								outputModalities: ['text'],
								thinkingModes: [],
							},
						],
					},
				];
				snapshot.state.activeConnectionId = 'dialog-fixture';
				snapshot.state.threads = [
					{
						id: threadId,
						kind: 'code',
						title: 'Disposable Electron dialogs',
						connectionId: 'dialog-fixture',
						model: 'fixture',
						messages: [],
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				];
				Object.assign(snapshot.state.toolSettings, {
					enabled: true,
					approvalMode: 'ask',
					commandExecution: false,
					mcpServers: [],
					skillDirectories: [],
					computerUse: { enabled: true },
				});
				await bridge.workspaceSave('local', snapshot.revision, snapshot.state);
				let approvals = 0;
				let background;
				const unsubscribe = bridge.onToolApproval((approval) => {
					if (approval.cancelled || approval.runId !== runId) return;
					const allowed = approval.computer?.app.id === appId && !approval.computer.setup;
					if (allowed) approvals++;
					void bridge.toolApprove(approval.id, allowed);
				});
				const execute = async (name, args) => {
					let result;
					try {
						result = await bridge.toolExecute({
							workspaceId: 'local',
							runId,
							threadId,
							name,
							arguments: args,
						});
					} catch (error) {
						throw new Error(`${name}${args.action ? ` (${args.action.type})` : ''}: ${error}`);
					}
					if (result.isError) throw new Error(JSON.stringify(result.content));
					if (background) {
						const current = await window[backgroundBinding]();
						if (
							!current.focused ||
							current.pointer.x !== background.pointer.x ||
							current.pointer.y !== background.pointer.y
						)
							throw new Error(
								`${name} (${args.action?.type ?? 'observe'}) changed foreground focus or the physical pointer: before ${JSON.stringify(background)}, after ${JSON.stringify(current)}. Keep the mouse still during this isolated test.`,
							);
					}
					return JSON.parse(result.content.find((item) => item.type === 'text').text);
				};
				const state = async (predicate) => {
					let current;
					for (let i = 0; i < 50; i++) {
						current = await window[binding]();
						if (predicate(current)) return current;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					throw new Error(
						`Native dialog did not reach its expected state: ${JSON.stringify(current)}`,
					);
				};
				try {
					await bridge.toolCatalog('local', runId, threadId);
					const listing = await execute('computer_apps', { query: appId });
					if (!listing.apps.some((item) => item.id === appId))
						throw new Error('Electron fixture absent from app discovery.');
					let frame = await execute('computer_open', { appId });
					const sessionId = frame.sessionId;
					const act = async (action) => {
						frame = await execute('computer_act', { sessionId, frameId: frame.frameId, action });
					};
					const observe = async () => {
						for (let attempt = 0; ; attempt++) {
							try {
								frame = await execute('computer_observe', { sessionId });
								return;
							} catch (error) {
								if (attempt >= 3 || !String(error).includes('window changed')) throw error;
								await new Promise((resolve) => setTimeout(resolve, 300));
							}
						}
					};
					const find = (label, action) => {
						const item = frame.elements.find(
							(item) =>
								(item.label === label || item.value === label) &&
								(!action || item.actions?.includes(action)),
						);
						if (!item)
							throw new Error(
								`Missing native ${action ?? ''} control ${label}: ${JSON.stringify(frame.elements)}`,
							);
						return item;
					};
					const press = (label) => act({ type: 'press', elementId: find(label, 'press').id });
					const checks = [];
					let openCount = 0;
					for (const selection of ['select', 'click'].filter(
						(kind) => selectedCase === 'all' || selectedCase === kind,
					)) {
						background = undefined;
						await window[binding]('open');
						await state((s) => s.active === 'open');
						await new Promise((resolve) => setTimeout(resolve, 400));
						await observe();
						background = await window[backgroundBinding](frame.window.bounds);
						if (!background.focused)
							throw new Error('Unable to establish the isolated foreground shield.');
						await observe();
						const file = find(
							'Selected fixture.png',
							selection === 'select' ? 'select' : undefined,
						);
						if (selection === 'select') await act({ type: 'select', elementId: file.id });
						else {
							if (!file.bounds) throw new Error('Native file icon has no screenshot bounds.');
							await act({
								type: 'click',
								x: Math.round(file.bounds.x + file.bounds.width / 2),
								y: Math.round(file.bounds.y + file.bounds.height / 2),
							});
						}
						await press('Choose fixture');
						openCount++;
						const selected = await state(
							(s) => s.results.filter((item) => item.kind === 'open').length === openCount,
						);
						const result = selected.results.at(-1);
						if (result.canceled || result.filePaths.length !== 1 || result.filePaths[0] !== chosen)
							throw new Error(
								`Native ${selection} chose the wrong file: ${JSON.stringify(result)}`,
							);
						checks.push(`open-${selection}`);
					}
					if (selectedCase === 'all' || selectedCase === 'save') {
						background = undefined;
						await window[binding]('save');
						await state((s) => s.active === 'save');
						await new Promise((resolve) => setTimeout(resolve, 400));
						await observe();
						background = await window[backgroundBinding](frame.window.bounds);
						if (!background.focused)
							throw new Error('Unable to establish save-panel foreground shield.');
						await observe();
						await act({ type: 'key', key: 'g', modifiers: ['cmd', 'shift'] });
						if (
							!/go to (the )?folder/i.test(frame.window.title ?? '') &&
							!frame.elements.some((item) =>
								/go to (the )?folder/i.test(item.label ?? item.value ?? ''),
							)
						) {
							throw new Error(
								'Command-Shift-G did not open the native Go to Folder sheet; no path text was sent.',
							);
						}
						for (const action of [
							{ type: 'key', key: 'a', modifiers: ['cmd'] },
							{ type: 'type', text: destination },
							{ type: 'key', key: 'return' },
						])
							await act(action);
						const name = frame.elements.find(
							(item) =>
								item.role === 'AXTextField' &&
								item.value?.startsWith('initial') &&
								item.actions?.includes('set_value'),
						);
						if (!name)
							throw new Error(
								`Save panel filename missing after Go to Folder: ${JSON.stringify(frame.elements)}`,
							);
						await act({ type: 'set_value', elementId: name.id, text: 'verified.png' });
						await press('Save fixture');
						const saved = (
							await state((s) => s.results.some((item) => item.kind === 'save'))
						).results.at(-1);
						if (saved.canceled || saved.filePath !== `${destination}/verified.png`)
							throw new Error(`Native save navigation did not apply: ${JSON.stringify(saved)}`);
						checks.push('save-keyboard-navigation');
					}
					await execute('computer_close', { sessionId });
					return {
						approvals,
						checks,
						selectedPath: chosen,
					};
				} finally {
					unsubscribe();
					await bridge.toolCancel(runId);
				}
			},
			{
				appId,
				binding,
				backgroundBinding,
				chosen: await realpath(chosen),
				destination: await realpath(destination),
				selectedCase,
			},
		);
		assert.equal(report.approvals, 1);
		console.log('Real Electron native-dialog fixture passed:', JSON.stringify(report));
	} finally {
		if (fixture.pid && fixture.exitCode === null && fixture.signalCode === null)
			await new Promise((resolve) => {
				const deadline = setTimeout(() => fixture.kill('SIGKILL'), 2000);
				fixture.once('exit', () => {
					clearTimeout(deadline);
					resolve();
				});
				fixture.kill('SIGTERM');
			});
	}
}
