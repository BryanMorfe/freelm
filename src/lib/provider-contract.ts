import type {
  ProviderDeclaration,
  ProviderEvent,
  ProviderRequest,
  ProviderResult,
} from '../provider-types';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(v) && !['constructor','prototype','__proto__'].includes(v);
export function validateProviderDeclarations(value: unknown): ProviderDeclaration[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid provider declarations.');
  const seen = new Set<string>();
  return value.map((v) => {
    if (
      !record(v) ||
      Object.keys(v).some((k) => !['id', 'name', 'capabilities'].includes(k)) ||
      !id(v.id) ||
      seen.has(v.id) ||
      typeof v.name !== 'string' ||
      !v.name.trim() ||
      v.name.length > 100 ||
      !record(v.capabilities) ||
      Object.keys(v.capabilities).some((k) => !['tools', 'streaming'].includes(k)) ||
      typeof v.capabilities.tools !== 'boolean' ||
      typeof v.capabilities.streaming !== 'boolean'
    )
      throw new Error('Invalid provider declaration.');
    seen.add(v.id);
    return {
      id: v.id,
      name: v.name,
      capabilities: { tools: v.capabilities.tools, streaming: v.capabilities.streaming },
    };
  });
}
export function validateProviderRequest(
  value: ProviderRequest,
  declaration: ProviderDeclaration,
): void {
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) =>
        !['version', 'model', 'system', 'messages', 'tools', 'maxOutputTokens', 'stream'].includes(
          k,
        ),
    ) ||
    value.version !== 1 ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 256 ||
    typeof value.system !== 'string' ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > 32768 ||
    typeof value.stream !== 'boolean' ||
    !Array.isArray(value.messages) ||
    value.messages.length > 1000 ||
    !Array.isArray(value.tools) ||
    value.tools.length > 128 ||
    JSON.stringify(value).length > 512000
  )
    throw new Error('Invalid provider request.');
  if (
    (value.tools.length && !declaration.capabilities.tools) ||
    (value.stream && !declaration.capabilities.streaming)
  )
    throw new Error('Adapter does not support the requested capability.');
  const names = new Set<string>(),
    calls = new Set<string>(),
    results = new Set<string>();
  for (const tool of value.tools) {
    if (
      !record(tool) ||
      !id(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== 'string' ||
      !record(tool.parameters) || (tool.strict !== undefined && typeof tool.strict !== 'boolean')
    )
      throw new Error('Invalid provider tool definition.');
    names.add(tool.name);
  }
  for (const message of value.messages) {
    if (
      !record(message) ||
      !['user', 'assistant', 'tool'].includes(message.role) ||
      typeof message.text !== 'string'
    )
      throw new Error('Invalid provider message.');
    if (message.role === 'tool') {
      if (
        typeof message.callId !== 'string' ||
        !calls.has(message.callId) ||
        results.has(message.callId)
      )
        throw new Error('Unmatched provider tool result.');
      results.add(message.callId);
    }
    if (message.calls !== undefined) {
      if (
        message.role !== 'assistant' ||
        !declaration.capabilities.tools ||
        !Array.isArray(message.calls)
      )
        throw new Error('Invalid provider tool history.');
      for (const call of message.calls) {
        if (
          !record(call) ||
          typeof call.id !== 'string' ||
          !call.id ||
          call.id.length > 256 ||
          calls.has(call.id) ||
          !id(call.name) ||
          !record(call.arguments)
        )
          throw new Error('Invalid provider tool history.');
        calls.add(call.id);
      }
    }
  }
}
/** One accumulator validates JSON and streamed events before tools can be executed. */
export function createProviderAccumulator(tools: ProviderRequest['tools']) {
  const names = new Set(tools.map((t) => t.name));
  const calls = new Map<string, { name: string; text: string; done: boolean }>();
  let text = '',
    terminal: 'stop' | 'tools' | undefined,
    count = 0,
    bytes = 0;
  const usage: ProviderResult['usage'] = {};
  return {
    push(raw: unknown): ProviderEvent {
      if (
        !record(raw) ||
        typeof raw.type !== 'string' ||
        terminal ||
        ++count > 16384 ||
        (bytes += JSON.stringify(raw).length) > 2 * 1024 * 1024
      )
        throw new Error('Invalid or oversized provider event stream.');
      const e = raw as unknown as ProviderEvent;
      switch (e.type) {
        case 'text':
          if (typeof e.text !== 'string') throw new Error('Invalid text delta.');
          text += e.text;
          break;
        case 'tool-start':
          if (
            typeof e.id !== 'string' ||
            !e.id ||
            e.id.length > 256 ||
            calls.has(e.id) ||
            !names.has(e.name) ||
            calls.size >= 128
          )
            throw new Error('Invalid tool call identity.');
          calls.set(e.id, { name: e.name, text: '', done: false });
          break;
        case 'tool-delta': {
          const call = calls.get(e.id);
          if (
            !call ||
            call.done ||
            typeof e.text !== 'string' ||
            call.text.length + e.text.length > 262144
          )
            throw new Error('Invalid tool argument delta.');
          call.text += e.text;
          break;
        }
        case 'tool-end': {
          const call = calls.get(e.id);
          if (!call || call.done || !record(JSON.parse(call.text)))
            throw new Error('Invalid tool arguments.');
          call.done = true;
          break;
        }
        case 'usage':
          for (const key of ['inputTokens', 'outputTokens'] as const) {
            if (e[key] !== undefined) {
              if (!Number.isSafeInteger(e[key]) || e[key]! < 0)
                throw new Error('Invalid provider usage.');
              usage[key] = e[key];
            }
          }
          break;
        case 'finish':
          if (
            !['stop', 'tools'].includes(e.reason) ||
            [...calls.values()].some((c) => !c.done) ||
            (e.reason === 'tools') !== calls.size > 0
          )
            throw new Error('Incomplete provider tool batch.');
          terminal = e.reason;
          break;
        case 'error':
          throw new Error(
            `Provider ${String(e.code).slice(0, 40)}: ${String(e.message).slice(0, 1000)}`,
          );
        default:
          throw new Error('Unknown provider event.');
      }
      return e;
    },
    finish(): ProviderResult {
      if (!terminal) throw new Error('Provider stream ended before completion.');
      return {
        text,
        calls: [...calls].map(([id, c]) => ({ id, name: c.name, arguments: JSON.parse(c.text) })),
        usage,
        finishReason: terminal,
      };
    },
  };
}
