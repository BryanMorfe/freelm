import type {
  ProviderDeclaration,
  ProviderEvent,
  ProviderRequest,
  ProviderRequestPlan,
} from '../../src/provider-types';
import {
  createProviderAccumulator,
  validateProviderRequest,
} from '../../src/lib/provider-contract';
import { createProviderSession } from './provider-session';
import { createSSEParser } from '../../src/lib/sse';

export interface ProviderAdapterBinding {
  code: string;
  declaration: ProviderDeclaration;
  baseUrl: string;
  allowedOrigins: string[];
  /** Must recheck enabled package hash, explicit provider.use and caller grants. */
  assertAccess(): void;
  /** Host-only secret, never included in transformation inputs. */
  credential?: { header: 'authorization' | 'x-api-key'; value: string };
  workerPath?: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Host transport with sequential, pure, bounded worker transformations. No tool execution. */
export async function runProviderAdapter(
  binding: ProviderAdapterBinding,
  request: ProviderRequest,
  onEvent: (event: ProviderEvent) => void,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  const check = () => {
    abort.throwIfAborted();
    binding.assertAccess();
  };
  check();
  validateProviderRequest(request, binding.declaration);
  const secrets = [binding.credential?.value, binding.credential?.header === 'authorization' ? binding.credential.value.replace(/^Bearer /, '') : undefined].filter((value): value is string => !!value);
  const clean = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[redacted credential]'), text);
  const session = createProviderSession(binding.code, binding.declaration.id, abort, binding.workerPath);
  let state: unknown = null,
    transforms = 0;
  const transform = async (phase: string, input: unknown) => {
    check();
    if (++transforms > 16384) throw new Error('Provider transformation limit exceeded.');
    const result = await session.transform({ phase, input: JSON.parse(clean(JSON.stringify(input))), state });
    check();
    return JSON.parse(clean(JSON.stringify(result))) as unknown;
  };
  try {
    const raw = await transform('request', request);
    if (
      !object(raw) ||
      Object.keys(raw).some((k) => !['path', 'headers', 'body', 'format'].includes(k)) ||
      typeof raw.path !== 'string' ||
      !/^\/(?!\/)/.test(raw.path) ||
      /[\\?#]/.test(raw.path) ||
      !object(raw.body) ||
      !['json', 'sse', 'ndjson'].includes(String(raw.format))
    )
      throw new Error('Invalid provider request plan.');
    const segments = raw.path.split('/').map(decodeURIComponent);
    if (segments.some((s) => s === '.' || s === '..' || /[\\/]/.test(s)))
      throw new Error('Invalid provider path.');
    const plan = raw as unknown as ProviderRequestPlan;
    const base = new URL(binding.baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !binding.allowedOrigins.includes(base.origin)
    )
      throw new Error('Provider origin is not granted.');
    base.pathname = base.pathname.replace(/\/+$/, '') + plan.path;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (plan.headers !== undefined) {
      if (!object(plan.headers) || Object.keys(plan.headers).length > 16)
        throw new Error('Invalid provider headers.');
      for (const [name, value] of Object.entries(plan.headers)) {
        // Deliberately narrow: arbitrary auth and transport headers are not plugin controlled.
        if (
          !['accept', 'anthropic-version', 'anthropic-beta'].includes(name.toLowerCase()) ||
          typeof value !== 'string' ||
          value.length > 1024
        )
          throw new Error('Provider header is not allowed.');
        headers.set(name, value);
      }
    }
    if (binding.credential) headers.set(binding.credential.header, binding.credential.value);
    check();
    const response = await fetcher(base, {
      method: 'POST',
      headers,
      body: JSON.stringify(plan.body),
      redirect: 'error',
      credentials: 'omit',
      signal: abort,
    });
    try {
      check();
      if (response.status >= 300 && response.status < 400)
        throw new Error('Provider redirects are forbidden.');
      if (Number(response.headers.get('content-length')) > 1024 * 1024)
        throw new Error('Provider response exceeds 1 MiB.');
      const accumulator = createProviderAccumulator(request.tools);
      const consume = async (phase: string, input: unknown) => {
        const output = await transform(phase, input);
        if (
          !object(output) ||
          Object.keys(output).some((k) => !['state', 'events'].includes(k)) ||
          !Array.isArray(output.events) ||
          output.events.length > 256
        )
          throw new Error('Invalid provider transformation output.');
        state = output.state ?? null;
        for (const event of output.events) {
          check();
          onEvent(accumulator.push(event));
        }
      };
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0,
        buffer = '';
      const frames: Array<{ data: string; event: string }> = [];
      const parser = createSSEParser((data, event) => {
        frames.push({ data, event });
      });
      const streaming = response.ok && plan.format !== 'json';
      const drain = async (text: string) => {
        if (!streaming) {
          buffer += text;
          return;
        }
        if (plan.format === 'sse') {
          parser.push(text);
          while (frames.length) await consume('frame', frames.shift());
        } else {
          buffer += text;
          let i: number;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const data = buffer.slice(0, i).replace(/\r$/, '');
            buffer = buffer.slice(i + 1);
            if (data.trim()) await consume('frame', { data, event: '' });
          }
        }
      };
      try {
        if (reader)
          while (true) {
            check();
            const chunk = await reader.read();
            check();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 1024 * 1024) throw new Error('Provider response exceeds 1 MiB.');
            // Feed small slices so a large network chunk cannot enqueue unbounded events.
            for (let offset = 0; offset < chunk.value.length; offset += 4096)
              await drain(
                decoder.decode(chunk.value.subarray(offset, offset + 4096), { stream: true }),
              );
          }
        await drain(decoder.decode());
        if (!streaming) {
          await consume('response', { status: response.status, body: clean(buffer) });
          if (!response.ok) throw new Error(`Provider HTTP ${response.status}.`);
        } else {
          if (plan.format === 'sse') {
            parser.finish();
            while (frames.length) await consume('frame', frames.shift());
          } else if (buffer.trim()) await consume('frame', { data: buffer, event: '' });
          await consume('end', null);
        }
        check();
        return accumulator.finish();
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    } finally {
      if (!response.body?.locked) await response.body?.cancel().catch(() => {});
    }
  } catch (error) {
    throw new Error(clean(error instanceof Error ? error.message : 'Provider adapter failed.'));
  } finally { session.close(); }
}
