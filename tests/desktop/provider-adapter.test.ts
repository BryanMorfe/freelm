import { validatePluginManifest } from '../../src/lib/plugin-manifest';
import exampleManifest from '../../examples/plugins/provider-adapters/manifest.json';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProviderAdapter, type ProviderAdapterBinding } from '../../electron/plugins/provider';
import { createProviderAccumulator } from '../../src/lib/provider-contract';
import type { ProviderRequest } from '../../src/provider-types';

let directory: string, workerPath: string, unconventional: string, messages: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(process.cwd(), 'node_modules/.provider-adapter-tests-'));
  workerPath = path.join(directory, 'worker.cjs');
  await build({
    entryPoints: ['electron/plugins/runtime-worker.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  const bundle = async (name: string) =>
    (
      await build({
        entryPoints: [`examples/plugins/provider-adapters/${name}.ts`],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: '__freelmPlugin',
        alias: { '@freelm/plugin-sdk': path.join(process.cwd(), 'packages/plugin-sdk/index.ts') },
      })
    ).outputFiles[0].text;
  unconventional = await bundle('unconventional');
  messages = await bundle('anthropic-like');
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
const request = (): ProviderRequest => ({
  version: 1,
  model: 'fixture',
  system: 'Be concise',
  messages: [{ role: 'user', text: 'Hello' }],
  tools: [],
  maxOutputTokens: 1024,
  stream: false,
});
function binding(code = unconventional, id = 'unconventional'): ProviderAdapterBinding {
  return {
    code,
    declaration: { id, name: 'Fixture', capabilities: { tools: true, streaming: true } },
    baseUrl: 'https://fixture.invalid/v1',
    allowedOrigins: ['https://fixture.invalid'],
    assertAccess() {},
    workerPath,
    credential: { header: 'x-api-key', value: 'fixture-secret' },
  };
}
const signal = () => new AbortController().signal;
const fetchReply = (body: string, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status }));
describe('sandboxed provider adapters', () => {
  it('translates unconventional request/response shapes and injects host credentials', async () => {
    const fetcher = fetchReply('{"answer":{"text":"Hello back"}}');
    await expect(
      runProviderAdapter(binding(), request(), () => {}, signal(), fetcher),
    ).resolves.toMatchObject({ text: 'Hello back', calls: [], finishReason: 'stop' });
    expect(String(fetcher.mock.calls[0][0])).toBe('https://fixture.invalid/v1/generate');
    const init = fetcher.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      engine: 'fixture',
      turns: [{ speaker: 'user', value: 'Hello' }],
    });
    expect(new Headers(init.headers).get('x-api-key')).toBe('fixture-secret');
    expect(init.redirect).toBe('error');
  });
  it('assembles Anthropic-like tools and usage from split SSE bytes', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"café"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    const bytes = new TextEncoder().encode(
      events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''),
    );
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const b of bytes) controller.enqueue(Uint8Array.of(b));
              controller.close();
            },
          }),
        ),
    );
    const result = await runProviderAdapter(
      binding(messages, 'messages'),
      {
        ...request(),
        stream: true,
        tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      },
      () => {},
      signal(),
      fetcher,
    );
    expect(result).toMatchObject({
      calls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'café' } }],
      usage: { inputTokens: 12, outputTokens: 8 },
      finishReason: 'tools',
    });
  });
  it('requires access before invoking code or transport', async () => {
    const fetcher = fetchReply('{}');
    await expect(
      runProviderAdapter(
        {
          ...binding(),
          assertAccess() {
            throw new Error('Provider use not granted');
          },
        },
        request(),
        () => {},
        signal(),
        fetcher,
      ),
    ).rejects.toThrow('not granted');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('blocks undeclared origins and unsupported capabilities', async () => {
    const fetcher = fetchReply('{}');
    await expect(
      runProviderAdapter(
        { ...binding(), allowedOrigins: [] },
        request(),
        () => {},
        signal(),
        fetcher,
      ),
    ).rejects.toThrow('origin');
    const b = binding();
    b.declaration.capabilities.streaming = false;
    await expect(
      runProviderAdapter(b, { ...request(), stream: true }, () => {}, signal(), fetcher),
    ).rejects.toThrow('capability');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose host APIs to transforms', async () => {
    const code = `globalThis.__freelmPlugin={default:{providers:{unconventional:(_,ctx)=>ctx.fetch('https://fixture.invalid')}}};`;
    await expect(
      runProviderAdapter(binding(code), request(), () => {}, signal(), fetchReply('{}')),
    ).rejects.toThrow();
  });
  it('redacts reflected credentials and rejects HTTP failure', async () => {
    await expect(
      runProviderAdapter(
        binding(),
        request(),
        () => {},
        signal(),
        fetchReply('{"answer":{"text":"fixture-secret"}}'),
      ),
    ).resolves.toMatchObject({ text: '[redacted credential]' });
    await expect(
      runProviderAdapter(binding(), request(), () => {}, signal(), fetchReply('{}', 401)),
    ).rejects.toThrow('rejected');
  });
  it('honors cancellation before work and revocation after transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = fetchReply('{}');
    await expect(
      runProviderAdapter(binding(), request(), () => {}, controller.signal, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    let revoked = false;
    await expect(
      runProviderAdapter(
        {
          ...binding(),
          assertAccess() {
            if (revoked) throw new Error('revoked');
          },
        },
        request(),
        () => {},
        signal(),
        async () => {
          revoked = true;
          return new Response('{}');
        },
      ),
    ).rejects.toThrow('revoked');
  });
  it('rejects a stream without terminal completion', async () => {
    await expect(
      runProviderAdapter(
        binding(messages, 'messages'),
        { ...request(), stream: true },
        () => {},
        signal(),
        fetchReply('event: ping\ndata: {"type":"ping"}\n\n'),
      ),
    ).rejects.toThrow('before completion');
  });
});
describe('canonical provider events', () => {
  it('never returns incomplete or duplicate tool batches', () => {
    const acc = createProviderAccumulator([{ name: 'lookup', description: '', parameters: {} }]);
    acc.push({ type: 'tool-start', id: 'a', name: 'lookup' });
    expect(() => acc.push({ type: 'tool-start', id: 'a', name: 'lookup' })).toThrow('identity');
    expect(() => acc.push({ type: 'finish', reason: 'tools' })).toThrow('Incomplete');
  });
  it('rejects output-limit errors, unknown tools and invalid usage', () => {
    for (const event of [
      { type: 'error', code: 'length', message: 'limit' },
      { type: 'tool-start', id: 'a', name: 'unknown' },
      { type: 'usage', inputTokens: -1 },
    ])
      expect(() => createProviderAccumulator([]).push(event)).toThrow();
  });
});

describe('provider package contract', () => {
  it('accepts the example and rejects duplicate IDs or unknown capabilities', () => {
    expect(validatePluginManifest(exampleManifest)).toMatchObject({
      contributes: { providers: exampleManifest.contributes.providers },
    });
    const duplicate = structuredClone(exampleManifest);
    duplicate.contributes.providers.push(duplicate.contributes.providers[0]);
    expect(() => validatePluginManifest(duplicate)).toThrow();
    const unknown = structuredClone(exampleManifest) as any;
    unknown.contributes.providers[0].capabilities.vision = true;
    expect(() => validatePluginManifest(unknown)).toThrow();
  });
});

describe('adapter vertical slice', () => {
 it('runs the real agent tool loop through routing, sandbox and synthetic endpoint', async () => {
  const { streamAgentChat } = await import('../../src/lib/agent');
  const { routeProviderRequest } = await import('../../electron/provider-routing');
  const { standardThinkingMode } = await import('../../src/lib/catalog');
  const code = `globalThis.__freelmPlugin={default:{providers:{unconventional:({phase,input})=> phase==='request' ? {path:'/turn',body:input,format:'json'} : {events:JSON.parse(input.body)}}}};`;
  const connection: import('../../src/types').Connection = { id:'fixture',name:'Fixture',baseUrl:'https://fixture.invalid',apiKey:'',chatApi:'chat/completions',providerAdapter:{pluginId:'fixture',accountId:'fixture',providerId:'unconventional',credentialHeader:'authorization'},models:{chat:'m',images:'',videos:'',speech:'',transcription:''},discoveredModels:[],catalog:[{id:'m',name:'m',enabled:true,tasks:['chat'],inputModalities:['text'],outputModalities:['text'],thinkingModes:[standardThinkingMode()]}] };
  let rounds=0;
  const fetcher: typeof fetch = async (_url,init) => {
   const input=JSON.parse(String(init?.body));
   if (++rounds===1) return new Response(JSON.stringify([{type:'tool-start',id:'call',name:input.tools[0].name},{type:'tool-delta',id:'call',text:'{"q":"test"}'},{type:'tool-end',id:'call'},{type:'finish',reason:'tools'}]));
   expect(input.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool',callId:'call',text:expect.stringContaining('result')})]));
   return new Response(JSON.stringify([{type:'text',text:'Done'},{type:'finish',reason:'stop'}]));
  };
  const execute = vi.fn(async () => ({content:[{type:'text' as const,text:'result'}]}));
  const result=await streamAgentChat({connection,model:'m',history:[{id:'u',role:'user',content:'Use tool',createdAt:1}],instructions:'',tools:[{name:'lookup',description:'Lookup',parameters:{type:'object'},source:'builtin'}],execute,onUpdate(){},request: (_c,input,signal,chunk=()=>{})=>routeProviderRequest(connection,{...input,id:'r',connectionId:'fixture',baseUrl:'',apiKey:'',providerAdapterRequired:true},{surface:'chat'},{generateWithProvider: options => runProviderAdapter(binding(code),options.request,options.onEvent,options.signal,fetcher)},chunk,signal)});
  expect(result.content).toBe('Done'); expect(execute).toHaveBeenCalledOnce(); expect(rounds).toBe(2);
 });
 it('keeps a single bounded sandbox realm across hundreds of frames', async () => {
  const code=`let count=0;globalThis.__freelmPlugin={default:{providers:{unconventional:({phase,input})=>{if(phase==='request')return {path:'/turn',body:{},format:'ndjson'};if(phase==='frame'){count++;return {events:[{type:'text',text:'.'}]};}return {events:[{type:'text',text:String(count)},{type:'finish',reason:'stop'}]};}}}};`;
  const result=await runProviderAdapter(binding(code),{...request(),stream:true},()=>{},signal(),fetchReply('{}\n'.repeat(200)));
  expect(result.text).toBe('.'.repeat(200)+'200');
 });
});
