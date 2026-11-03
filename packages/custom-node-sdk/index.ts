export type PortType =
  | 'any'
  | 'text'
  | 'number'
  | 'boolean'
  | 'object'
  | 'list'
  | 'file'
  | 'image'
  | 'audio'
  | 'video'
  | 'signal';
export interface Port {
  id: string;
  label: string;
  type: PortType;
  required?: boolean;
}
export interface ConfigField {
  key: string;
  label: string;
  kind?: 'text' | 'textarea' | 'number' | 'json' | 'select' | 'boolean' | 'lines' | 'secret';
  description?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}
export interface CustomNodeManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  inputs: Port[];
  outputs: Port[];
  fields: ConfigField[];
  permissions: { network?: string[]; inference?: boolean };
  retrySafe?: boolean;
  discovery?: boolean;
}
export interface Artifact {
  kind: 'file';
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}
export interface SecretReference {
  secretRef: string;
}
export interface NodeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  secret?: SecretReference;
  idempotencyKey?: string;
}
export interface NodeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface NodeContext {
  readonly operationId: string;
  readonly config: Record<string, unknown>;
  request(request: NodeRequest): Promise<NodeResponse>;
  /** No automatic reconnect or retry. Breaking iteration closes the response. */
  stream(request: NodeRequest & { format?: 'text' | 'base64' }): AsyncIterable<string>;
  download(
    request: NodeRequest & { name: string },
  ): Promise<{ status: number; headers: Record<string, string>; artifact: Artifact }>;
  /** Omit fieldName for raw bytes; specify it for multipart form data. */
  upload(
    request: Omit<NodeRequest, 'body'> & {
      artifact: Artifact;
      fieldName?: string;
      fields?: Record<string, string>;
    },
  ): Promise<NodeResponse>;
  artifacts: {
    write(name: string, mimeType: string, text: string): Promise<Artifact>;
    read(artifact: Artifact): Promise<string>;
    writeBytes(name: string, mimeType: string, base64: string): Promise<Artifact>;
    readBytes(
      artifact: Artifact,
      offset?: number,
      length?: number,
    ): Promise<{ base64: string; size: number }>;
  };
  inference(request: { connectionId: string; model: string; prompt: string }): Promise<unknown>;
  progress(message: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}
export interface NodeDefinition {
  execute(
    inputs: Record<string, unknown>,
    context: NodeContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  discover?(context: NodeContext): Promise<unknown>;
}
export const defineNode = (definition: NodeDefinition): NodeDefinition => definition;
/** Polling never resubmits creation. Submit once, retain the job ID, then poll it. */
export async function poll<T>(
  context: NodeContext,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  attempts = 30,
  delayMs = 1000,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (done(value)) return value;
    await context.sleep(delayMs);
  }
  throw new Error('Remote job polling timed out; inspect the existing job before retrying.');
}

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}
/** Parses SSE across arbitrary UTF-8 chunks, CR/LF boundaries and multiline data.
 * This deliberately never reconnects: the caller owns retry and paid-job safety. */
export async function* parseSSE(chunks: AsyncIterable<string>): AsyncGenerator<SSEEvent> {
  let buffer = '',
    data: string[] = [],
    event = 'message',
    id: string | undefined,
    retry: number | undefined;
  const line = (text: string): SSEEvent | undefined => {
    if (text === '') {
      const result = data.length
        ? {
            event: event || 'message',
            data: data.join('\n'),
            ...(id === undefined ? {} : { id }),
            ...(retry === undefined ? {} : { retry }),
          }
        : undefined;
      data = [];
      event = 'message';
      retry = undefined;
      return result;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
      retry = Number(value);
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) throw new Error('SSE line exceeds 1 MiB.');
    while (true) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const at = match.index;
      if (buffer[at] === '\r' && at === buffer.length - 1) break;
      const text = buffer.slice(0, at);
      const width = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(at + width);
      const value = line(text);
      if (value) yield value;
      if (data.join('').length > 1024 * 1024) throw new Error('SSE event exceeds 1 MiB.');
    }
  }
  // SSE dispatches only events terminated by an empty line; do not invent an EOF event.
  if (buffer.endsWith('\r')) {
    const value = line(buffer.slice(0, -1));
    if (value) yield value;
  }
}
