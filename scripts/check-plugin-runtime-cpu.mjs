import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

// Runs the actual isolated worker in Electron's Node runtime. A test-only host
// bridge suspension reproduces OS descheduling without changing guest code or
// production bundles. No app profile or provider is accessed.
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.resolve('node_modules/.freelm-cpu-regression-'));
try {
	const source = await readFile('electron/plugins/surface-runtime-worker.ts', 'utf8');
	const marker = 'const operationId = context.getString(handles[2]), id = ++nextId, deferred = context.newPromise();';
	if (!source.includes(marker)) throw new Error('Update the test-only bridge suspension marker.');
	const instrumented = source.replace(marker, `
			if (workerData.testSuspendMs && !workerData.testSuspended) {
				workerData.testSuspended = true;
				const before = process.threadCpuUsage(), wall = performance.now();
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.testSuspendMs);
				const elapsed = process.threadCpuUsage(before);
				port.postMessage({kind:'test-suspension',wallMs:performance.now()-wall,cpuMs:(elapsed.user+elapsed.system)/1000});
			}
			${marker}`);
	const worker = path.join(directory, 'worker.cjs');
	await build({ stdin: { contents: instrumented, resolveDir: path.resolve('electron/plugins'), loader: 'ts' }, outfile: worker, bundle: true, platform: 'node', format: 'cjs', external: ['quickjs-emscripten'] });
	const driver = path.join(directory, 'driver.cjs');
	await writeFile(driver, String.raw`
const {Worker}=require('node:worker_threads');
const assert=require('node:assert/strict');
assert.equal(typeof process.threadCpuUsage,'function','Use the target Electron runtime with thread CPU accounting.');
async function run(activate,{suspend=0,command=false}={}) {
  const worker=new Worker(process.argv[2],{workerData:{code:'globalThis.__freelmPlugin={default:{activate:'+activate+'}}',context:{},cpuBudgetMs:200,jsonLimit:1048576,testSuspendMs:suspend}});
  const observations=[];
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Worker did not settle.')),5000);
      worker.on('error',reject);
      worker.on('message',message=>{
        if(message.kind==='test-suspension')observations.push(message);
        if(message.kind==='call')worker.postMessage({kind:'result',id:message.id,json:'null'});
        if(message.kind==='ready'&&command){worker.postMessage({kind:'command',id:1,name:'loop',json:'{}'});return;}
        if(message.kind==='ready'||message.kind==='error'){clearTimeout(timer);resolve({message,observations});}
      });
    });
  } finally {await worker.terminate();}
}
(async()=>{
  const suspended=await run('ctx=>{ctx.composer.getState();let n=0;for(let i=0;i<100000;i++)n+=i;}',{suspend:350});
  assert.equal(suspended.message.kind,'ready',JSON.stringify(suspended));
  assert.ok(suspended.observations[0].wallMs>=300);
  assert.ok(suspended.observations[0].cpuMs<200);
  const activation=await run('()=>{while(true){}}');
  assert.match(activation.message.error,/CPU budget/);
  const callback=await run("ctx=>{ctx.commands.register({id:'loop',title:'Loop',run:()=>{while(true){}}});}",{command:true});
  assert.match(callback.message.error,/CPU budget/);
  console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,suspension:suspended.observations[0],activationLimit:'passed',callbackLimit:'passed'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
	const result = await promisify(execFile)(require('electron'), [driver, worker], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000 });
	process.stdout.write(result.stdout);
} finally {
	await rm(directory, { recursive: true, force: true });
}
