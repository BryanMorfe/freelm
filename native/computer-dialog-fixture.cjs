// Disposable real Electron Open/Save panels. The control file only opens a
// panel; all selection, navigation, typing and confirmation are driven by the
// production Computer Use tools. Never run against a user profile.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(process.argv[process.argv.indexOf('--fixture-root') + 1]);
const temporary = fs.realpathSync(os.tmpdir());
if (!root.startsWith(temporary + path.sep)) throw new Error('Fixture root must be temporary.');
app.setPath('userData', path.join(root, 'electron-user-data'));
let win;
let busy = false;
let sequence = 0;
const state = { ready: false, pid: process.pid, results: [] };
const save = () => {
	fs.writeFileSync(path.join(root, 'dialog-state.pending.json'), JSON.stringify(state));
	fs.renameSync(path.join(root, 'dialog-state.pending.json'), path.join(root, 'dialog-state.json'));
};
app.whenReady().then(async () => {
	win = new BrowserWindow({
		width: 800,
		height: 500,
		show: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false },
	});
	await win.loadURL(
		'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Native dialog fixture</title><body style="font:20px system-ui;padding:40px">Disposable native Open/Save panel fixture</body>',
	);
	win.showInactive();
	state.ready = true;
	save();
	setInterval(async () => {
		if (busy) return;
		let request;
		try {
			request = JSON.parse(fs.readFileSync(path.join(root, 'dialog-control.json'), 'utf8'));
		} catch {
			return;
		}
		if (!Number.isInteger(request.sequence) || request.sequence <= sequence) return;
		sequence = request.sequence;
		busy = true;
		state.active = request.kind;
		save();
		try {
			const result =
				request.kind === 'open'
					? await dialog.showOpenDialog(win, {
							title: 'Fixture Open',
							buttonLabel: 'Choose fixture',
							defaultPath: path.join(root, 'Files'),
							properties: ['openFile'],
							filters: [{ name: 'Images', extensions: ['png'] }],
						})
					: await dialog.showSaveDialog(win, {
							title: 'Fixture Save',
							buttonLabel: 'Save fixture',
							defaultPath: path.join(root, 'Files', 'initial.png'),
							filters: [{ name: 'Images', extensions: ['png'] }],
						});
			state.results.push({ sequence, kind: request.kind, ...result });
		} catch (error) {
			state.error = String(error);
		}
		delete state.active;
		busy = false;
		save();
	}, 100).unref();
});
app.on('window-all-closed', () => app.quit());
