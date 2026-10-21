import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated React hook fixture: no installed plugins, accounts, providers, or user profile.
const expect = baseExpect.configure({ timeout: 10_000 });
const directory = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-navigation-'));
let desktop;
try {
	await build({
		stdin: {
			contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePluginTabs } from './src/components/usePluginTabs';
import { saveNavigationPreferences } from './src/lib/navigation-preferences';
const control = window.fixture = { pending: [], calls: 0 };
window.desktop = {
  pluginSnapshot: () => new Promise((resolve, reject) => { control.calls++; control.pending.push({resolve,reject}); }),
  pluginTabContent: () => { throw new Error('Not requested by navigation'); },
  pluginInvokeAction: () => { throw new Error('Not requested by navigation'); },
};
function Probe({enabled}) {
  const tabs = usePluginTabs(enabled);
  control.select = tabs.setActiveKey;
  return <><output data-testid="active">{tabs.active?.key || 'none'}</output><output data-testid="restoring">{String(tabs.restoring)}</output></>;
}
function Fixture() {
  const [enabled,setEnabled] = useState(false);
  const [version,setVersion] = useState(0);
  control.enable = setEnabled;
  control.reset = (key) => { saveNavigationPreferences({pluginKey:key}); setEnabled(false); setVersion(v=>v+1); };
  control.resolve = snapshot => control.pending.shift().resolve(snapshot);
  control.reject = () => control.pending.shift().reject(new Error('Temporary transport failure'));
  return <Probe key={version} enabled={enabled}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		platform: 'browser',
		format: 'iife',
		outfile: path.join(directory, 'fixture.js'),
		define: { 'process.env.NODE_ENV': '"development"' },
	});
	await writeFile(
		path.join(directory, 'index.html'),
		'<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>',
	);
	const main = path.join(directory, 'main.cjs');
	await writeFile(
		main,
		`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`,
	);
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	desktop = await electron.launch({ args: [main], env });
	const page = await desktop.firstWindow();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const key = 'fixture.notes/notebook';
	const snapshot = {
		accounts: [],
		plugins: [
			{
				enabled: true,
				package: { hash: 'fixture', installedBytes: 1 },
				manifest: {
					manifestVersion: 2,
					id: 'fixture.notes',
					contributes: { tabs: [{ id: 'notebook', title: 'Notebook', entry: 'ui.ts' }] },
				},
			},
		],
	};
	const savedKey = () =>
		page.evaluate(() => JSON.parse(localStorage.getItem('freelm-navigation-v1')).pluginKey);
	const reset = async () => {
		await page.evaluate((key) => window.fixture.reset(key), key);
		await expect(page.getByTestId('active')).toHaveText('none');
		await expect.poll(savedKey).toBe(key);
	};
	const enable = async () => {
		await page.evaluate(() => window.fixture.enable(true));
		await expect.poll(() => page.evaluate(() => window.fixture.pending.length)).toBe(1);
	};
	const resolve = async (value = snapshot) => {
		await page.evaluate((value) => window.fixture.resolve(value), value);
	};
	await expect(page.getByTestId('active')).toHaveText('none');
	await reset();
	await expect.poll(() => page.evaluate(() => window.fixture.calls)).toBe(0);
	await enable();
	await expect(page.getByTestId('restoring')).toHaveText('true');
	await expect.poll(savedKey).toBe(key);
	await resolve();
	await expect(page.getByTestId('active')).toHaveText(key);
	await page.reload();
	await expect(page.getByTestId('active')).toHaveText('none');
	await expect.poll(savedKey).toBe(key);
	await enable();
	await resolve();
	await expect(page.getByTestId('active')).toHaveText(key);
	console.log('PASS saved plugin tab survives delayed workspace/snapshot load and reload');

	await page.evaluate(() => window.fixture.enable(false));
	await expect(page.getByTestId('active')).toHaveText('none');
	await expect.poll(savedKey).toBe(key);
	await enable();
	await resolve();
	await expect(page.getByTestId('active')).toHaveText(key);
	console.log('PASS temporary host disable does not erase navigation');

	await reset();
	await enable();
	await page.evaluate(() => window.fixture.reject());
	await expect(page.getByTestId('restoring')).toHaveText('false');
	await expect.poll(savedKey).toBe(key);
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => page.evaluate(() => window.fixture.pending.length)).toBe(1);
	await resolve();
	await expect(page.getByTestId('active')).toHaveText(key);
	console.log('PASS transient snapshot failure preserves saved tab for retry');

	await reset();
	await enable();
	await page.evaluate(() => window.fixture.select(null));
	await resolve();
	await expect(page.getByTestId('active')).toHaveText('none');
	await expect.poll(savedKey).toBe(null);
	console.log('PASS explicit built-in navigation wins over pending plugin snapshot');

	for (const unavailable of [
		{ plugins: [], accounts: [] },
		{ ...snapshot, plugins: snapshot.plugins.map((plugin) => ({ ...plugin, enabled: false })) },
	]) {
		await reset();
		await enable();
		await resolve(unavailable);
		await expect(page.getByTestId('active')).toHaveText('none');
		await expect.poll(savedKey).toBe(null);
	}
	console.log('PASS missing and disabled plugins fall back without enabling anything');
	await expect.poll(() => errors).toEqual([]);
} finally {
	await desktop?.close();
	await rm(directory, { recursive: true, force: true });
}
