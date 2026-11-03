import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { zipSync } from 'fflate';

// Browser plugin not available. Exercise the real Electron renderer/preload/host/compiler/guest.
// Disposable profile; no user accounts or provider calls.
const home = await mkdtemp(path.join(os.tmpdir(), 'freelm-plugin-runtime-smoke-'));
let desktop;
const source = path.resolve('examples/plugins/notebook');
const entries = Object.create(null);
async function collect(dir) {
  for (const item of await readdir(dir, { withFileTypes:true })) {
    const filename = path.join(dir,item.name);
    if (item.isDirectory()) await collect(filename);
    else entries[path.relative(source,filename).split(path.sep).join('/')] = new Uint8Array(await readFile(filename));
  }
}
await collect(source);
const original = zipSync(entries);
const packagePath = path.join(home,'notebook.freelm-plugin');
await writeFile(packagePath, original);
try {
  await writeFile(path.join(home,'config.json'), JSON.stringify({format:'freelm-config-v1',version:1,encryptedKeys:{},theme:'dark',connections:[{id:'fixture',name:'Disconnected fixture',baseUrl:'http://127.0.0.1:1/v1',apiKey:'',chatApi:'responses',models:{chat:'fixture',images:'',videos:'',speech:'',transcription:''},discoveredModels:[],catalog:[{id:'fixture',name:'Fixture',enabled:true,tasks:['chat'],inputModalities:['text'],outputModalities:['text'],thinkingModes:[{id:'low',name:'Low',parameters:{responses:{reasoning:{effort:'low'}}}}]}]}],activeConnectionId:'fixture',memorySettings:{savedMemories:false,referenceHistory:false}, toolSettings:{enabled:false,workspaceRoot:'',commandExecution:false,approvalMode:'ask',mcpServers:[],skillDirectories:[],imageGeneration:{enabled:false,connectionId:'fixture',model:'fixture',size:'',quality:''},pythonExecution:{enabled:false}}}));
  await writeFile(path.join(home,'workspace.json'), JSON.stringify({format:'freelm-workspace-v2',version:1,projects:[],generations:[],threads:[{id:'plugin-smoke-thread',kind:'chat',title:'Plugin test',titleSource:'manual',connectionId:'fixture',model:'fixture',messages:[],createdAt:Date.now(),updatedAt:Date.now()}]}));
  const env = {...process.env, FREELM_HOME:home, FREELM_USER_DATA:home};
  delete env.ELECTRON_RUN_AS_NODE; delete env.FREELM_DEV_URL;
  const executablePath = process.env.FREELM_SMOKE_EXECUTABLE;
  desktop = await electron.launch({...executablePath ? {executablePath,args:[`--user-data-dir=${home}`]}:{args:['.']},env});
  desktop.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  console.log('Isolated Electron launched.');
  const page = await desktop.firstWindow({timeout:20000});
  console.log('Test window opened.');
  page.setDefaultTimeout(20000);
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  page.on('console', msg => { if(['error','warning'].includes(msg.type())) console.log('Renderer:',msg.text()); });
  desktop.process().stdout?.on('data',chunk=>process.stdout.write(chunk));
  await desktop.evaluate(({webContents})=>{ for(const contents of webContents.getAllWebContents()) contents.on('will-frame-navigate', event=>console.log('Frame navigation',event.url,event.isMainFrame)); });
  await page.locator('.app-shell').waitFor();
  await page.getByRole('navigation',{name:'Workspaces',exact:true}).getByRole('button',{name:'Plugins',exact:true}).click();
  await page.getByRole('button',{name:'Install plugin',exact:true}).click();
  await page.getByLabel('Choose plugin ZIP', {exact:true}).setInputFiles(packagePath);
  await expect(page.getByText('Review plugin',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Install reviewed plugin',exact:true}).click();
  await expect(page.getByRole('switch',{name:'Enable Notebook'})).toBeVisible({timeout:60000});
  console.log('ZIP reviewed and TypeScript compiled inside desktop.');
  await page.getByRole('button',{name:'Add account',exact:true}).click();
  await page.getByRole('textbox',{name:'Account label',exact:true}).fill('Personal');
  await page.getByRole('button',{name:'Connect account',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Personal',exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(async()=>(await window.desktop.pluginSnapshot()).accounts[0]?.tools.length)).toBe(2);
  const snapshot=await page.evaluate(()=>window.desktop.pluginSnapshot());
  const account=snapshot.accounts[0];
  assert.equal(account.tools.length,2); assert.deepEqual(account.access.tools,[]);
  await page.getByRole('navigation',{name:'Workspaces',exact:true}).getByRole('button',{name:'Home',exact:true}).click();
  await page.getByRole('button',{name:'Notebook · Notebook',exact:true}).click();
  const frame=page.frameLocator('iframe[title="Notebook: Notebook"]');
  await expect(frame.getByRole('heading',{name:'Notebook'})).toBeVisible().catch(async error=>{console.log('Frames',await Promise.all(page.frames().map(async f=>({url:f.url(),html:(await f.content()).slice(0,1200)}))));throw error;});
  await frame.getByRole('textbox',{name:'Note',exact:true}).fill('Independent plugin note');
  await frame.getByRole('button',{name:'Save note',exact:true}).click();
  await expect(frame.getByRole('status')).toHaveText('Saved on this computer');
  await page.screenshot({path:'/tmp/freelm-plugin-runtime-dark.png'});
  const isolated=await frame.locator('body').evaluate(()=>({desktop:typeof window.desktop,process:typeof window.process,require:typeof window.require,hostAccess:(()=>{try{return !!parent.document.body;}catch{return false;}})()}));
  assert.deepEqual(isolated,{desktop:'undefined',process:'undefined',require:'undefined',hostAccess:false});
  // CSP alone allows ICE/STUN traffic. An isolated negative-control probe sent
  // packets without Connection-Allowlist; the actual plugin response must block it.
  const stun = createSocket('udp4');
  let stunPackets = 0;
  stun.on('message', () => stunPackets++);
  try {
    await new Promise((resolve, reject) => {
      stun.once('error', reject);
      stun.bind(0, '127.0.0.1', resolve);
    });
    await frame.locator('body').evaluate(async (_element, port) => {
      const connection = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      try {
        connection.createDataChannel('plugin-network-isolation-test');
        await connection.setLocalDescription(await connection.createOffer());
        await new Promise(resolve => setTimeout(resolve, 1000));
      } finally {
        connection.close();
      }
    }, stun.address().port);
    assert.equal(stunPackets, 0, 'Plugin UI sent WebRTC traffic outside its host network broker.');
  } finally {
    await new Promise(resolve => stun.close(resolve));
  }
  await page.reload();
  await page.getByRole('button',{name:'Notebook · Notebook',exact:true}).click();
  await expect(page.frameLocator('iframe[title="Notebook: Notebook"]').getByRole('textbox',{name:'Note',exact:true})).toHaveValue('Independent plugin note');
  const read=await page.evaluate(async accountId=>{
    const api=window.desktop;
    await api.pluginCommand({type:'access',accountId,access:{chat:true,code:false,botIds:[],allowRemote:false,tools:['read_note']}});
    const catalog=await api.toolCatalog('local','plugin-smoke-run','plugin-smoke-thread');
    const tool=catalog.tools.find(tool=>tool.source==='plugin');
    if(!tool) throw new Error('Plugin tool was not available in Chat');
    try {return await api.toolExecute({workspaceId:'local',threadId:'plugin-smoke-thread',runId:'plugin-smoke-run',name:tool.name,arguments:{}});}
    finally{await api.toolCancel('plugin-smoke-run');}
  },account.id);
  assert.match(JSON.stringify(read),/Independent plugin note/);
  console.log('Custom tab saved note; reload and real Chat tool read the same account storage.');
  const bad=zipSync({...entries,'src/index.ts':new TextEncoder().encode('export default { BROKEN SYNTAX !')});
  const failure=await page.evaluate(async bytes=>{
    const review=await window.desktop.pluginPreparePackage(bytes);
    try {await window.desktop.pluginInstallPackage(review.reviewId);return null;}catch(error){return String(error);}
  },[...bad]);
  assert.match(failure,/compile|error|expected/i);
  assert.equal((await page.evaluate(()=>window.desktop.pluginSnapshot())).plugins[0].manifest.version,'1.0.0');
  const manifest=JSON.parse(new TextDecoder().decode(entries['manifest.json'])); manifest.version='1.0.1';
  const updated=zipSync({...entries,'manifest.json':new TextEncoder().encode(JSON.stringify(manifest))});
  await page.evaluate(async bytes=>{
    const review=await window.desktop.pluginPreparePackage(bytes);
    await window.desktop.pluginInstallPackage(review.reviewId);
    window.dispatchEvent(new Event('freelm:plugins-changed'));
  },[...updated]);
  const after=await page.evaluate(()=>window.desktop.pluginSnapshot());
  assert.equal(after.plugins[0].manifest.version,'1.0.1');
  assert.deepEqual(after.accounts[0].access.tools,[]);
  await expect(page.frameLocator('iframe[title="Notebook: Notebook"]').getByRole('textbox',{name:'Note',exact:true})).toHaveValue('Independent plugin note');
  // Native guard must stop a guest from navigating to another origin.
  const beforeFrames=page.frames();
  const guest=beforeFrames.find(frame=>frame.parentFrame()===page.mainFrame());
  assert.ok(guest);
  await guest.evaluate(()=>{location.href='https://example.invalid/plugin-must-not-navigate';});
  await expect.poll(()=>page.frames().some(frame=>frame.url().includes('example.invalid'))).toBe(false);
  await page.evaluate(async()=>{
    await window.desktop.pluginCommand({type:'enable',pluginId:'dev.freelm.notebook',enabled:false});
    window.dispatchEvent(new Event('freelm:plugins-changed'));
  });
  await expect(page.getByRole('button',{name:'Notebook · Notebook',exact:true})).toHaveCount(0);
  await expect(page.locator('iframe[title="Notebook: Notebook"]')).toHaveCount(0);
  assert.deepEqual(errors,[]);
  console.log('PASS: ZIP import, install-time TS+CSS build, account-scoped persistent UI/model data, opaque frame isolation, update rollback, grant reset and disable removal.');
} finally {
  if(desktop) { const timer=setTimeout(()=>desktop.process().kill('SIGKILL'),5000); await desktop.close().catch(()=>{}); clearTimeout(timer); }
  await rm(home,{recursive:true,force:true});
}
