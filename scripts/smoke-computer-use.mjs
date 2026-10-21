import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { exerciseElectronDialogs } from './computer-dialog-fixture.mjs';

// Default: passive verification only. Explicit --exercise-fixture additionally
// captures/controls disposable AppKit and WKWebView fixtures through the packaged FreeLM host.
// It requires preexisting permissions, never requests OS access, never sends a
// provider request, and never reads or modifies the real FreeLM profile.
const exerciseFixture = process.argv.includes('--exercise-fixture');
const exerciseDialogs = process.argv.includes('--exercise-dialogs');
const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
const launchServices = process.env.FREELM_SMOKE_LAUNCH_SERVICES === '1';
if (exerciseFixture || exerciseDialogs || launchServices) {
	assert.equal(process.platform, 'darwin', 'The native fixture requires macOS.');
	assert.ok(
		executablePath &&
			path.isAbsolute(executablePath) &&
			executablePath.includes('.app/Contents/MacOS/'),
		'Native fixture and LaunchServices runs require FREELM_SMOKE_EXECUTABLE pointing to the installed FreeLM.app executable.',
	);
}

async function launchServicesWrapper(profile, configuredExecutable) {
	const appExecutable = await realpath(configuredExecutable);
	const appPath = appExecutable.slice(0, appExecutable.indexOf('.app/Contents/MacOS/') + 4);
	const wrapper = path.join(profile, 'launch-services.mjs');
	// macOS attributes a direct Playwright spawn to its launching host. Open the
	// registered bundle normally so its existing grants apply, while forwarding
	// its own inspector/CDP messages to preserve Electron.launch's normal API.
	await writeFile(
		wrapper,
		`#!${process.execPath}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const profile = ${JSON.stringify(profile)};
const appPath = ${JSON.stringify(appPath)};
const args = process.argv.slice(2);
if (!args.includes('--user-data-dir=' + profile)) throw new Error('LaunchServices requires an isolated Electron profile.');
const files = [path.join(profile, 'launch-services.stdout.log'), path.join(profile, 'launch-services.stderr.log')];
const streams = [process.stdout, process.stderr];
const offsets = [0, 0];
for (const file of files) fs.writeFileSync(file, '');
const forward = () => files.forEach((file, index) => {
  const data = fs.readFileSync(file);
  if (data.length > offsets[index]) streams[index].write(data.subarray(offsets[index]));
  offsets[index] = data.length;
});
const timer = setInterval(forward, 25);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.FREELM_DEV_URL;
delete env.NODE_OPTIONS;
const launched = spawn('/usr/bin/open', [
  '-n', '-W', '-g', '--env', 'FREELM_HOME=' + profile, '--env', 'FREELM_USER_DATA=' + profile,
  '--stdout', files[0], '--stderr', files[1], appPath, '--args', ...args,
], { env, stdio: ['ignore', 'inherit', 'inherit'] });
launched.on('error', error => { clearInterval(timer); process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });
launched.on('exit', code => { clearInterval(timer); forward(); process.exitCode = code ?? 1; });
`,
		{ mode: 0o700 },
	);
	// LaunchServices owns the app process, so killing a timed-out wrapper cannot
	// clean it up. Match both this exact executable and our unique profile before
	// stopping an orphan; no existing user instance can match this expression.
	const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const processPattern = `^${escapeRegex(appExecutable)}[[:space:]].*--user-data-dir=${escapeRegex(profile)}([[:space:]]|$)`;
	const ownedPids = async () => {
		try {
			const { stdout } = await promisify(execFile)('/usr/bin/pgrep', ['-f', processPattern]);
			return stdout
				.trim()
				.split(/\s+/)
				.map(Number)
				.filter((pid) => Number.isInteger(pid) && pid > 1);
		} catch (error) {
			if (error.code === 1) return [];
			throw error;
		}
	};
	const cleanup = async () => {
		for (let attempt = 0; attempt < 30; attempt++) {
			const pids = await ownedPids();
			if (!pids.length) return;
			for (const pid of pids) {
				try {
					process.kill(pid, attempt < 20 ? 'SIGTERM' : 'SIGKILL');
				} catch (error) {
					if (error.code !== 'ESRCH') throw error;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(
			'The disposable LaunchServices instance did not exit; its temporary profile was preserved.',
		);
	};
	return { executablePath: wrapper, cleanup };
}

async function exerciseNativeFixture(desktop, page, profile) {
	const status = await page.evaluate(() => window.desktop.computerStatus());
	console.log('Native fixture permission preflight:', JSON.stringify(status));
	assert.ok(
		status.available && status.accessibility && status.screenRecording,
		'Fixture not launched: the installed FreeLM helper must already have Accessibility and Screen Recording. No OS permission request was made.',
	);
	const appId = `app.freelm.fixture.computer.${randomUUID().replaceAll('-', '')}`;
	const app = path.join(profile, 'FreeLM Computer Fixture.app');
	const binary = path.join(app, 'Contents', 'MacOS', 'fixture');
	const stateFile = path.join(profile, 'fixture-state.json');
	const fixtureDirectory = path.join(profile, 'Native picker fixtures');
	const targetDirectory = path.join(fixtureDirectory, 'Target folder 🧪');
	await mkdir(path.dirname(binary), { recursive: true });
	await mkdir(targetDirectory, { recursive: true });
	await writeFile(path.join(fixtureDirectory, 'fixture-only.txt'), 'Disposable Computer Use test.');
	await writeFile(path.join(targetDirectory, 'destination.txt'), 'Disposable navigation target.');
	const xml = (value) =>
		value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	await writeFile(
		path.join(app, 'Contents', 'Info.plist'),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${appId}</string>
<key>CFBundleName</key><string>FreeLM Computer Fixture</string>
<key>CFBundleDisplayName</key><string>FreeLM Computer Fixture</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>FreeLMFixtureStatePath</key><string>${xml(stateFile)}</string>
<key>FreeLMFixtureDirectoryPath</key><string>${xml(fixtureDirectory)}</string>
</dict></plist>`,
	);
	await promisify(execFile)(
		'/usr/bin/xcrun',
		[
			'swiftc',
			'-parse-as-library',
			'-module-cache-path',
			path.join(profile, 'swift-module-cache'),
			'-target',
			`${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
			path.resolve('native/computer-use-fixture.swift'),
			'-o',
			binary,
		],
		{ timeout: 120_000, maxBuffer: 1_000_000 },
	);
	const fixture = spawn(binary, [], { stdio: ['ignore', 'ignore', 'pipe'] });
	let launchError;
	let fixtureDiagnostics = '';
	fixture.stderr.on('data', (data) => {
		fixtureDiagnostics = (fixtureDiagnostics + data.toString()).slice(-6000);
	});
	fixture.on('error', (error) => {
		launchError = error;
	});
	const readFixture = async () => JSON.parse(await readFile(stateFile, 'utf8'));
	// Independent AppKit and DOM state is only available to this disposable test page.
	const stateBinding = `fixtureState_${randomUUID().replaceAll('-', '')}`;
	await page.exposeFunction(stateBinding, readFixture);
	const foregroundBinding = `fixtureForeground_${randomUUID().replaceAll('-', '')}`;
	const hostWindow = await desktop.browserWindow(page);
	const hostWindowId = await hostWindow.evaluate((window) => window.id);
	await page.exposeFunction(foregroundBinding, (bounds) =>
		desktop.evaluate(
			({ app, BrowserWindow }, { hostWindowId, bounds }) => {
				const host = BrowserWindow.fromId(hostWindowId);
				if (!host || host.isDestroyed()) throw new Error('The isolated fixture host closed.');
				// Cover the native target with our own disposable window. The helper
				// must route to the approved app without relying on screen hit testing.
				host.setBounds({
					x: Math.floor(bounds.x - 12),
					y: Math.floor(bounds.y - 12),
					width: Math.ceil(bounds.width + 24),
					height: Math.ceil(bounds.height + 24),
				});
				host.show();
				app.focus({ steal: true });
				host.focus();
				return process.pid;
			},
			{ hostWindowId, bounds },
		),
	);
	try {
		let ready;
		for (let attempt = 0; attempt < 100; attempt++) {
			if (launchError) throw launchError;
			if (fixture.exitCode !== null || fixture.signalCode !== null)
				throw new Error(
					`The disposable fixture exited before becoming ready. ${fixtureDiagnostics}`,
				);
			try {
				ready = await readFixture();
			} catch {
				/* Wait for the fixture's atomic initial state write. */
			}
			if (ready?.ready) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready?.ready, `The disposable fixture did not become ready. ${fixtureDiagnostics}`);
		assert.equal(ready.pid, fixture.pid);
		const marker = '1234567890123456789🧪 native';
		const result = await page.evaluate(
			async ({ appId, marker, targetDirectory, stateBinding, foregroundBinding }) => {
				const bridge = window.desktop;
				const snapshot = await bridge.workspaceLoad('local');
				const threadId = crypto.randomUUID(),
					runId = crypto.randomUUID();
				snapshot.state.connections = [
					{
						id: 'fixture-provider',
						name: 'No provider is called',
						baseUrl: 'http://127.0.0.1:9/v1',
						apiKey: '',
						chatApi: 'responses',
						models: {
							chat: 'fixture-vision',
							images: '',
							videos: '',
							speech: '',
							transcription: '',
						},
						discoveredModels: [],
						catalog: [
							{
								id: 'fixture-vision',
								name: 'Fixture image capability',
								enabled: true,
								tasks: ['chat'],
								inputModalities: ['text', 'image'],
								outputModalities: ['text'],
								thinkingModes: [],
							},
						],
					},
				];
				snapshot.state.activeConnectionId = 'fixture-provider';
				snapshot.state.threads = [
					{
						id: threadId,
						kind: 'code',
						title: 'Disposable native fixture',
						connectionId: 'fixture-provider',
						model: 'fixture-vision',
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
						throw new Error(
							`${name}${args.action ? ` (${args.action.type})` : ''}: ${String(error)}`,
						);
					}
					if (baseline) assertBackground(await window[stateBinding](), name);
					return result;
				};
				const images = new Map();
				const parse = (result) => {
					if (result.isError) throw new Error(JSON.stringify(result.content));
					const text = result.content.find((item) => item.type === 'text');
					const frame = JSON.parse(text.text);
					if (
						frame.app.id !== appId ||
						!result.content.some((item) => item.type === 'image' && item.purpose === 'computer')
					)
						throw new Error('Expected only the approved fixture observation.');
					images.set(
						frame.frameId,
						result.content.find((item) => item.type === 'image' && item.purpose === 'computer')
							.dataUrl,
					);
					return frame;
				};
				const center = (frame, label) => {
					const element = frame.elements.find((item) => item.label === label);
					if (!element?.bounds) throw new Error(`Fixture control missing: ${label}`);
					return {
						x: Math.floor(element.bounds.x + element.bounds.width / 2),
						y: Math.floor(element.bounds.y + element.bounds.height / 2),
					};
				};
				const fixtureState = async (accept, description) => {
					let state;
					for (let attempt = 0; attempt < 50; attempt++) {
						state = await window[stateBinding]();
						if (accept(state)) return state;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					throw new Error(`Native fixture did not ${description}: ${JSON.stringify(state)}`);
				};
				const samePointer = (actual, expected) =>
					Math.abs(actual.x - expected.x) < 0.5 && Math.abs(actual.y - expected.y) < 0.5;
				let foregroundPid;
				let baseline;
				let shield;
				let foregroundInput;
				const foregroundKeys = [];
				const recordForegroundKey = (event) => foregroundKeys.push(event.key);
				const assertBackground = (state, description) => {
					if (state.frontmostPid !== foregroundPid)
						throw new Error(`${description} activated the native target or another app.`);
					if (
						state.activationPids
							.slice(baseline.activationPids.length)
							.some((pid) => pid !== foregroundPid)
					)
						throw new Error(`${description} briefly stole foreground focus.`);
					if (!samePointer(state.physicalPointer, baseline.physicalPointer))
						throw new Error(
							`${description} moved the physical pointer. Keep the mouse still during this isolated test.`,
						);
					if (
						foregroundKeys.length ||
						foregroundInput.value !== 'Foreground input must stay unchanged'
					)
						throw new Error(
							`${description} leaked input into the foreground host: ${JSON.stringify(foregroundKeys)}.`,
						);
				};
				const imagePoint = (frame, point) => ({
					x: Math.round(
						((point.x - frame.window.bounds.x) * frame.imageSize.width) / frame.window.bounds.width,
					),
					y: Math.round(
						((point.y - frame.window.bounds.y) * frame.imageSize.height) /
							frame.window.bounds.height,
					),
				});
				const assertSheetCapture = async (frame, state) => {
					for (const field of ['x', 'y', 'width', 'height']) {
						if (Math.abs(frame.window.bounds[field] - state.panelBounds[field]) > 3)
							throw new Error(`Sheet ${field} does not match independent AppKit geometry.`);
					}
					if (String(frame.window.id) !== String(state.panelWindowId))
						throw new Error('The tool captured a different window than the native sheet.');
					const image = new Image();
					image.src = images.get(frame.frameId);
					await image.decode();
					if (
						image.naturalWidth !== frame.imageSize.width ||
						image.naturalHeight !== frame.imageSize.height
					)
						throw new Error('Reported screenshot dimensions do not match the decoded JPEG.');
					const bounds = frame.window.bounds;
					if (
						Math.abs(image.naturalWidth / bounds.width - image.naturalHeight / bounds.height) > 0.01
					)
						throw new Error('The sheet screenshot has a different aspect ratio than its window.');
					const marker = state.marker;
					const x = Math.round(
						((marker.bounds.x + marker.bounds.width / 2 - bounds.x) * image.naturalWidth) /
							bounds.width,
					);
					const y = Math.round(
						((marker.bounds.y + marker.bounds.height / 2 - bounds.y) * image.naturalHeight) /
							bounds.height,
					);
					if (x < 1 || y < 1 || x >= image.naturalWidth - 1 || y >= image.naturalHeight - 1)
						throw new Error('The independent sheet marker is outside the captured rectangle.');
					const canvas = document.createElement('canvas');
					canvas.width = image.naturalWidth;
					canvas.height = image.naturalHeight;
					const context = canvas.getContext('2d');
					context.drawImage(image, 0, 0);
					const pixel = [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
					if (pixel.some((channel, i) => Math.abs(channel - marker.rgb[i]) > 45))
						throw new Error(
							`Sheet capture is stale or offset: marker ${marker.generation} expected ${marker.rgb}, got ${pixel}.`,
						);
				};
				try {
					const catalog = await bridge.toolCatalog('local', runId, threadId);
					if (!catalog.tools.some((tool) => tool.name === 'computer_open'))
						throw new Error('Computer Use missing from fixture catalog.');
					const listing = await execute('computer_apps', { query: appId });
					if (!JSON.parse(listing.content[0].text).apps.some((item) => item.id === appId))
						throw new Error('Running fixture absent from native registry.');
					let frame = parse(await execute('computer_open', { appId }));
					const sessionId = frame.sessionId;
					const openedState = await window[stateBinding]();
					shield = document.createElement('div');
					shield.style.cssText =
						'position:fixed;inset:0;z-index:2147483647;background:#252525;color:white;padding:32px;font:16px system-ui';
					shield.textContent =
						'Disposable foreground shield — Computer Use must interact with the covered native fixture without activating it.';
					foregroundInput = document.createElement('input');
					foregroundInput.value = 'Foreground input must stay unchanged';
					foregroundInput.style.cssText =
						'display:block;width:90%;margin-top:24px;font:16px system-ui';
					shield.append(foregroundInput);
					document.body.append(shield);
					foregroundPid = await window[foregroundBinding](openedState.windowBounds);
					foregroundInput.focus();
					window.addEventListener('keydown', recordForegroundKey, true);
					baseline = await fixtureState(
						(state) => state.frontmostPid === foregroundPid,
						'yield foreground focus to the isolated host',
					);
					frame = parse(await execute('computer_observe', { sessionId }));
					if (String(frame.window.id) !== String(openedState.windowId))
						throw new Error('Background observation selected a different native target window.');
					assertBackground(await window[stateBinding](), 'Background observation');
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'click', ...center(frame, 'Fixture input') },
						}),
					);
					assertBackground(await window[stateBinding](), 'Background input click');
					const staleFrameId = frame.frameId;
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'type', text: marker },
						}),
					);
					let typedState = await fixtureState(
						(state) => state.text === marker,
						'receive background Unicode typing',
					);
					assertBackground(typedState, 'Background Unicode typing');
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'key', key: 'backspace' },
						}),
					);
					typedState = await fixtureState(
						(state) => state.text === marker.slice(0, -1),
						'receive a background Backspace key',
					);
					assertBackground(typedState, 'Background Backspace');
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'type', text: marker.slice(-1) },
						}),
					);
					typedState = await fixtureState(
						(state) => state.text === marker,
						'restore the native input after Backspace',
					);
					if (
						!typedState.inputEventFrontmostPids.length ||
						typedState.inputEventFrontmostPids.some((pid) => pid !== foregroundPid)
					)
						throw new Error(
							'The native input received text while the wrong application was foreground.',
						);
					assertBackground(typedState, 'Background key and text routing');
					let staleRejected = false;
					try {
						await execute('computer_act', {
							sessionId,
							frameId: staleFrameId,
							action: { type: 'type', text: 'THIS MUST NEVER APPEAR' },
						});
					} catch (error) {
						staleRejected = String(error).includes('stale');
					}
					if (!staleRejected) throw new Error('The host accepted a stale action frame.');
					const dragBounds = typedState.drag.bounds;
					const dragStart = imagePoint(frame, { x: dragBounds.x + 120, y: dragBounds.y + 36 });
					const dragEnd = imagePoint(frame, { x: dragBounds.x + 330, y: dragBounds.y + 20 });
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'drag', ...dragStart, toX: dragEnd.x, toY: dragEnd.y },
						}),
					);
					const dragState = await fixtureState(
						(state) => state.drag.events.at(-1)?.kind === 'up',
						'receive native mouse-down, drag, and mouse-up',
					);
					const dragEvents = dragState.drag.events;
					if (
						dragEvents.filter((event) => event.kind === 'down').length !== 1 ||
						dragEvents.filter((event) => event.kind === 'up').length !== 1 ||
						!dragEvents.some((event) => event.kind === 'drag') ||
						dragEvents[0].kind !== 'down'
					)
						throw new Error(
							`Native drag event sequence was incomplete: ${JSON.stringify(dragEvents)}.`,
						);
					const dragLast = dragEvents.at(-1);
					if (Math.abs(dragLast.x - 330) > 3 || Math.abs(dragLast.y - 20) > 3)
						throw new Error(`Native drag endpoint was wrong: ${JSON.stringify(dragLast)}.`);
					if (
						dragEvents.some(
							(event) =>
								event.frontmostPid !== foregroundPid ||
								!samePointer(event.physicalPointer, baseline.physicalPointer),
						)
					)
						throw new Error(
							'Drag changed foreground focus or moved the physical pointer during an event.',
						);
					assertBackground(dragState, 'Background drag');
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'click', ...center(frame, 'Apply fixture text') },
						}),
					);
					// A real attached NSOpenPanel reproduces the reported geometry and
					// routing boundary; all navigation stays inside this temporary profile.
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'click', ...center(frame, 'Open fixture sheet') },
						}),
					);
					let sheetState = await fixtureState(
						(state) => state.panelOpen && state.marker,
						'open the native sheet',
					);
					frame = parse(await execute('computer_observe', { sessionId }));
					await assertSheetCapture(frame, sheetState);
					const firstSheetImage = images.get(frame.frameId);
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'click', ...center(frame, 'Refresh sheet marker') },
						}),
					);
					sheetState = await fixtureState(
						(state) => state.marker?.generation === 1,
						'receive a coordinate click in the sheet',
					);
					await assertSheetCapture(frame, sheetState);
					frame = parse(await execute('computer_observe', { sessionId }));
					await assertSheetCapture(frame, sheetState);
					if (images.get(frame.frameId) === firstSheetImage)
						throw new Error('Changed native sheet pixels were served from a stale capture.');
					const choice = frame.elements.findIndex(
						(item) => item.label === 'Fixture choice Beta' || item.value === 'Fixture choice Beta',
					);
					let row;
					for (let index = choice; index >= 0; index--) {
						if (
							frame.elements[index].role === 'AXRow' &&
							frame.elements[index].actions?.includes('select')
						) {
							row = frame.elements[index];
							break;
						}
					}
					if (!row)
						throw new Error('The native outline row did not advertise an AX select action.');
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'select', elementId: row.id },
						}),
					);
					await fixtureState(
						(state) => state.selection === 'Fixture choice Beta',
						'select the native outline row',
					);
					for (const action of [
						{ type: 'key', key: 'g', modifiers: ['cmd', 'shift'] },
						{ type: 'key', key: 'a', modifiers: ['cmd'] },
						{ type: 'type', text: targetDirectory },
						{ type: 'key', key: 'return' },
					]) {
						frame = parse(
							await execute('computer_act', { sessionId, frameId: frame.frameId, action }),
						);
					}
					sheetState = await fixtureState(
						(state) => state.directory === targetDirectory && state.panelOpen,
						'navigate using Cmd+Shift+G, typed text, and Return',
					);
					frame = parse(await execute('computer_observe', { sessionId }));
					await assertSheetCapture(frame, sheetState);
					const sheetWindowId = frame.window.id;
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'key', key: 'escape' },
						}),
					);
					await fixtureState(
						(state) => !state.panelOpen && state.panelCancelled,
						'cancel the native sheet with Escape',
					);
					frame = parse(await execute('computer_observe', { sessionId }));
					if (frame.window.id === sheetWindowId)
						throw new Error('Observation retained a closed sheet.');
					// A real WKWebView has a separate WebContent process. AppKit event
					// delivery alone cannot prove that browser DOM controls receive input.
					frame = parse(
						await execute('computer_act', {
							sessionId,
							frameId: frame.frameId,
							action: { type: 'click', ...center(frame, 'Open WebKit fixture') },
						}),
					);
					let webState = await fixtureState(
						(state) => state.web?.visible && state.web?.ready && state.web?.viewBounds,
						'load the local, nonpersistent WKWebView fixture',
					);
					if (!webState.web.url.startsWith('file:'))
						throw new Error('WebKit fixture must use the disposable local-file transport.');
					frame = parse(await execute('computer_observe', { sessionId }));
					const webPoint = (id, x, y) => {
						const bounds = webState.web.bounds[id];
						if (!bounds) throw new Error(`Missing independent DOM bounds: ${id}`);
						return imagePoint(frame, {
							x: webState.web.viewBounds.x + bounds.x + (x ?? bounds.width / 2),
							y: webState.web.viewBounds.y + bounds.y + (y ?? bounds.height / 2),
						});
					};
					const webAction = async (action) => {
						frame = parse(
							await execute('computer_act', { sessionId, frameId: frame.frameId, action }),
						);
					};
					const webEventsSince = (offset, target) =>
						webState.web.events.slice(offset).filter((event) => event.target === target);
					let webOffset = webState.web.events.length;
					// Click the span inside the button: do not accidentally substitute an
					// AXPress on its parent for proof of coordinate mouse event delivery.
					await webAction({ type: 'click', ...webPoint('web-nested-label') });
					webState = await fixtureState(
						(state) => state.web.clicks === 1,
						'change DOM state after a coordinate click on the nested button label',
					);
					const nestedEvents = webEventsSince(webOffset, 'web-nested-label');
					const nestedTypes = nestedEvents.map((event) => event.type);
					if (
						!['mousedown', 'mouseup', 'click'].every((type) => nestedTypes.includes(type)) ||
						nestedTypes.indexOf('mousedown') > nestedTypes.indexOf('mouseup') ||
						nestedTypes.indexOf('mouseup') > nestedTypes.indexOf('click') ||
						nestedEvents.some((event) => !event.isTrusted)
					)
						throw new Error(
							`WebKit nested button did not receive native mouse events: ${JSON.stringify(nestedEvents)}`,
						);
					assertBackground(webState, 'WebKit nested coordinate click');
					webOffset = webState.web.events.length;
					const webDragStart = webPoint('web-drag', 100, 42);
					const webDragEnd = webPoint('web-drag', 360, 24);
					await webAction({
						type: 'drag',
						...webDragStart,
						toX: webDragEnd.x,
						toY: webDragEnd.y,
					});
					webState = await fixtureState(
						(state) =>
							state.web.events
								.slice(webOffset)
								.some((event) => event.target === 'web-drag' && event.type === 'mouseup'),
						'receive WebKit DOM mouse-down, drag movement, and mouse-up',
					);
					const webDragEvents = webEventsSince(webOffset, 'web-drag');
					const webDown = webDragEvents.findIndex((event) => event.type === 'mousedown');
					const webUp = webDragEvents.findIndex((event) => event.type === 'mouseup');
					if (
						webDown < 0 ||
						webUp <= webDown ||
						webDragEvents.filter((event) => event.type === 'mousedown').length !== 1 ||
						webDragEvents.filter((event) => event.type === 'mouseup').length !== 1 ||
						!webDragEvents
							.slice(webDown + 1, webUp)
							.some((event) => event.type === 'mousemove' && event.buttons === 1) ||
						webDragEvents.some((event) => !event.isTrusted)
					)
						throw new Error(
							`WebKit drag event sequence was incomplete: ${JSON.stringify(webDragEvents)}`,
						);
					const webEndpoint = webDragEvents[webUp];
					const webDragBounds = webState.web.bounds['web-drag'];
					if (
						Math.abs(webEndpoint.x - webDragBounds.x - 360) > 3 ||
						Math.abs(webEndpoint.y - webDragBounds.y - 24) > 3
					)
						throw new Error(`WebKit drag endpoint was wrong: ${JSON.stringify(webEndpoint)}`);
					assertBackground(webState, 'WebKit background drag');
					webOffset = webState.web.events.length;
					await webAction({ type: 'click', ...webPoint('web-input') });
					webState = await fixtureState(
						(state) => state.web.activeElement === 'web-input',
						'focus the DOM typing input while its application stays background',
					);
					await webAction({ type: 'type', text: marker });
					webState = await fixtureState(
						(state) => state.web.text === marker,
						'change the DOM value through background Unicode typing',
					);
					if (
						!webEventsSince(webOffset, 'web-input').some(
							(event) => event.type === 'input' && event.isTrusted,
						)
					)
						throw new Error('WebKit typing changed no trusted DOM input event.');
					await webAction({ type: 'key', key: 'backspace' });
					webState = await fixtureState(
						(state) => state.web.text === marker.slice(0, -1),
						'change the DOM value through a background Backspace key',
					);
					const webKeys = webEventsSince(webOffset, 'web-input');
					if (
						!['keydown', 'keyup'].every((type) =>
							webKeys.some(
								(event) => event.type === type && event.key === 'Backspace' && event.isTrusted,
							),
						)
					)
						throw new Error(
							`WebKit Backspace did not produce a DOM key pair: ${JSON.stringify(webKeys)}`,
						);
					await webAction({ type: 'type', text: marker.slice(-1) });
					webState = await fixtureState(
						(state) => state.web.text === marker,
						'restore the DOM typing value',
					);
					assertBackground(webState, 'WebKit Unicode typing and key routing');
					if (webState.web.activeElement === 'web-value' || webState.web.value !== '')
						throw new Error('WebKit set_value must begin with an unfocused, empty field.');
					const webValueElement = () =>
						frame.elements.find(
							(element) =>
								element.label === 'WebKit value input' && element.actions?.includes('set_value'),
						);
					if (!webValueElement())
						throw new Error('WebKit value input did not advertise an AX set_value action.');
					const initialWebValue = 'First empty-field value 🧪';
					await webAction({
						type: 'set_value',
						elementId: webValueElement().id,
						text: initialWebValue,
					});
					webState = await fixtureState(
						(state) => state.web.value === initialWebValue,
						'set the actual DOM value of an unfocused empty WebKit input',
					);
					const webValue = `Set through accessibility 🧪 ${marker}`;
					if (!webValueElement())
						throw new Error('WebKit value input vanished after its first set_value.');
					await webAction({ type: 'set_value', elementId: webValueElement().id, text: webValue });
					webState = await fixtureState(
						(state) => state.web.value === webValue,
						'persist set_value in the actual WebKit DOM, beyond an AX success response',
					);
					await webAction({ type: 'click', ...webPoint('web-blur') });
					const webSampleCount = webState.web.sampleCount;
					webState = await fixtureState(
						(state) =>
							state.web.activeElement !== 'web-value' &&
							state.web.sampleCount >= webSampleCount + 3,
						'blur the WebKit input and resample its actual DOM value',
					);
					if (webState.web.value !== webValue)
						throw new Error('WebKit set_value was transient and disappeared after blur.');
					if (webState.web.submittedValue !== webValue)
						throw new Error('The WebKit form did not read the actual set_value result.');
					if (
						webState.web.eventContext.some(
							(event) =>
								event.frontmostPid !== foregroundPid ||
								!samePointer(event.physicalPointer, baseline.physicalPointer),
						)
					)
						throw new Error(
							'WebKit event delivery changed foreground focus or moved the physical pointer.',
						);
					assertBackground(webState, 'WebKit set_value after blur');
					await execute('computer_close', { sessionId });
					let closeRejected = false;
					try {
						await execute('computer_observe', { sessionId });
					} catch {
						closeRejected = true;
					}
					if (!closeRejected) throw new Error('A closed fixture session remained observable.');
					return {
						approvals,
						staleRejected,
						closeRejected,
						imageSize: frame.imageSize,
						backgroundPid: foregroundPid,
						dragEvents: dragEvents.length,
						webEvents: webState.web.events.length,
						webValue,
						physicalPointer: baseline.physicalPointer,
					};
				} finally {
					window.removeEventListener('keydown', recordForegroundKey, true);
					shield?.remove();
					unsubscribe();
					await bridge.toolCancel(runId);
				}
			},
			{
				appId,
				marker,
				targetDirectory: await realpath(targetDirectory),
				stateBinding,
				foregroundBinding,
			},
		);
		assert.equal(result.approvals, 1);
		let final = await readFixture();
		for (
			let attempt = 0;
			attempt < 50 && (final.text !== marker || final.clicks !== 1);
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			final = await readFixture();
		}
		assert.equal(final.text, marker, 'Native typing must reach only the disposable fixture.');
		assert.equal(final.clicks, 1, 'Exactly one native button click must apply the fixture text.');
		assert.equal(
			final.frontmostPid,
			result.backgroundPid,
			'The isolated Electron host must remain foreground.',
		);
		assert.deepEqual(
			final.physicalPointer,
			result.physicalPointer,
			'The physical pointer must remain unchanged.',
		);
		assert.ok(
			result.dragEvents >= 3,
			'The native drag oracle must observe down, drag, and up events.',
		);
		assert.ok(result.imageSize.width > 0 && result.imageSize.height > 0);
		assert.equal(final.web.text, marker, 'WebKit typing must update the actual DOM input value.');
		assert.equal(
			final.web.value,
			result.webValue,
			'WebKit set_value must persist in the actual DOM after blur.',
		);
		assert.equal(
			final.web.submittedValue,
			result.webValue,
			'WebKit FormData must contain the set_value result.',
		);
		assert.equal(
			final.web.clicks,
			1,
			'The nested WebKit button must receive exactly one coordinate click.',
		);
		assert.ok(result.webEvents > 0, 'WebKit assertions must use actual DOM event evidence.');
		console.log(
			'Installed Computer Use fixture passed: app consent; a covered background target with independent foreground input and unchanged physical pointer; native Unicode typing, Backspace, coordinate clicks, drag down/move/up and endpoint; stale-frame rejection; NSOpenPanel sheet geometry and fresh marker pixels; sheet coordinate input, AX outline selection, Cmd+Shift+G/type/Return navigation and Escape cancellation; local WKWebView nested-button mouse events, drag down/move/up and endpoint, Unicode typing and Backspace DOM events, and set_value persistence after blur. Verified against independent AppKit and DOM state; no provider requests or OS setup requests.',
		);
	} finally {
		// Playwright bindings belong to this disposable page and disappear when
		// the page closes. It has no removeExposedFunction API; cleanup must not
		// mask the actual assertion failure or leave the native fixture running.
		if (fixture.pid && fixture.exitCode === null && fixture.signalCode === null) {
			await new Promise((resolve) => {
				const hardStop = setTimeout(() => fixture.kill('SIGKILL'), 2000);
				fixture.once('exit', () => {
					clearTimeout(hardStop);
					resolve();
				});
				fixture.kill('SIGTERM');
			});
		}
	}
}

const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-computer-native-')));
const seedModule = path.join(profile, 'seed.mjs');
await build({
	stdin: {
		contents:
			'export { initialState } from "./src/lib/state"; export { StateStore } from "./electron/state-store"; export { defaultToolSettings } from "./src/lib/tool-settings";',
		resolveDir: process.cwd(),
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: seedModule,
});
const { initialState, StateStore, defaultToolSettings } = await import(
	pathToFileURL(seedModule).href
);
const seeded = initialState();
seeded.toolSettings = defaultToolSettings();
await new StateStore(
	path.join(profile, 'workspace.json'),
	{
		available: () => false,
		encrypt: () => {
			throw new Error('No fixture secrets');
		},
		decrypt: () => {
			throw new Error('No fixture secrets');
		},
	},
	path.join(profile, 'config.json'),
).save(seeded);
let desktop;
let launchServicesHost;
try {
	const env = { ...process.env, FREELM_USER_DATA: profile };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.FREELM_HOME;
	delete env.FREELM_DEV_URL;
	// Packaged apps ignore the development-only FREELM_USER_DATA override.
	// Isolate both portable storage and Electron's single-instance metadata.
	if (executablePath) env.FREELM_HOME = profile;
	if (launchServices) launchServicesHost = await launchServicesWrapper(profile, executablePath);
	desktop = await electron.launch({
		...(executablePath
			? {
					executablePath: launchServicesHost?.executablePath ?? executablePath,
					args: [`--user-data-dir=${profile}`],
				}
			: { args: ['.'] }),
		env,
	});
	if (process.env.FREELM_SMOKE_NATIVE_HELPER) {
		assert.ok(
			exerciseFixture || exerciseDialogs,
			'A candidate native helper is only supported by an explicit disposable fixture.',
		);
		assert.ok(path.isAbsolute(process.env.FREELM_SMOKE_NATIVE_HELPER));
		await desktop.evaluate(({ app }, helper) => {
			if (!app.isPackaged)
				throw new Error('Candidate helper smoke requires the isolated packaged host.');
			const children = process.getBuiltinModule('node:child_process');
			const original = children.spawn;
			const packaged = process
				.getBuiltinModule('node:path')
				.join(process.resourcesPath, 'computer', 'freelm-computer');
			children.spawn = function (command, ...args) {
				return original.call(this, command === packaged ? helper : command, ...args);
			};
		}, process.env.FREELM_SMOKE_NATIVE_HELPER);
	}
	const page = await desktop.firstWindow();
	page.setDefaultTimeout(30_000);
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => !!window.desktop?.computerStatus);
	await page.locator('.app-shell').waitFor();
	assert.equal(
		(await page.evaluate(() => window.desktop.storageInfo())).location,
		path.join(profile, 'config.json'),
		'The smoke must use only its disposable profile.',
	);
	await page.waitForFunction(async () => !!(await window.desktop.workspaceLoad('local')).state);
	const result = await page.evaluate(async () => {
		const bridge = window.desktop;
		const snapshot = await bridge.workspaceLoad('local');
		if (snapshot.state.toolSettings?.computerUse?.enabled)
			throw new Error('Computer Use must default off.');
		const request = {
			workspaceId: 'local',
			conversationKind: 'code',
			kind: 'apps',
			query: 'Notes',
		};
		let disabled = false;
		try {
			await bridge.composerDiscover(request);
		} catch {
			disabled = true;
		}
		if (!disabled) throw new Error('Disabled Computer Use exposed app discovery.');
		const status = await bridge.computerStatus();
		const sessions = await bridge.computerSessions();
		snapshot.state.toolSettings.computerUse = { enabled: true };
		await bridge.workspaceSave('local', snapshot.revision, snapshot.state);
		const discovered = await bridge.composerDiscover(request);
		const app = discovered.items.find(
			(item) => item.kind === 'app' && item.id === 'com.apple.Notes',
		);
		return {
			platform: bridge.platform,
			status,
			sessions,
			app: app && { id: app.id, label: app.label, hasIcon: !!app.icon },
			disabled,
		};
	});
	assert.equal(result.sessions.length, 0);
	if (result.platform === 'darwin') {
		assert.equal(result.status.available, true, result.status.message);
		assert.equal(typeof result.status.accessibility, 'boolean');
		assert.equal(typeof result.status.screenRecording, 'boolean');
		assert.equal(result.app?.id, 'com.apple.Notes');
		assert.equal(result.app?.hasIcon, true);
	}
	if (exerciseFixture) await exerciseNativeFixture(desktop, page, profile);
	if (exerciseDialogs) await exerciseElectronDialogs(desktop, page, profile);
	// A different origin must not reach even the permission-setup endpoint.
	const appUrl = page.url();
	await page.goto('data:text/html,<h1>Untrusted fixture</h1>');
	const denied = await page.evaluate(async () => {
		const results = [];
		for (const action of [
			() => window.desktopNative.computerStatus(),
			() => window.desktopNative.computerSessions(),
			() => window.desktopNative.computerStop('fixture'),
			() => window.desktopNative.computerSetup('request'),
		]) {
			try {
				await action();
				results.push(false);
			} catch {
				results.push(true);
			}
		}
		return results;
	});
	assert.deepEqual(denied, [true, true, true, true]);
	assert.deepEqual(errors, []);
	await page.goto(appUrl);
	await page.locator('.app-shell').waitFor();
	console.log(
		`Native Computer Use smoke passed: default-off, host-gated app discovery, real Notes identity/icon, passive permission status, empty session state, and untrusted-sender rejection for all new IPC controls. ${exerciseFixture ? 'Capture/input were confined to the explicit disposable fixture.' : 'No capture or input performed.'}`,
	);
} finally {
	try {
		if (desktop) await desktop.close();
	} finally {
		if (launchServicesHost) await launchServicesHost.cleanup();
		await rm(profile, { recursive: true, force: true });
	}
}
