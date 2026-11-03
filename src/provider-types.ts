/** Version 1 text/tool adapter contract. Contains no credentials or executable tools. */
export interface ProviderDeclaration {
  id: string;
  name: string;
  capabilities: { tools: boolean; streaming: boolean };
}
export interface ProviderRequest {
  version: 1;
  model: string;
  system: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'tool';
    text: string;
    callId?: string;
    calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  }>;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }>;
  maxOutputTokens: number;
  stream: boolean;
}
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; id: string; name: string }
  | { type: 'tool-delta'; id: string; text: string }
  | { type: 'tool-end'; id: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'finish'; reason: 'stop' | 'tools' }
  | {
      type: 'error';
      code: 'authentication' | 'rate-limit' | 'length' | 'filtered' | 'protocol' | 'provider';
      message: string;
    };
export interface ProviderResult {
  text: string;
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens?: number; outputTokens?: number };
  finishReason: 'stop' | 'tools';
}
/** Host validates the relative path and injects credentials after this plan is returned. */
export interface ProviderRequestPlan {
  path: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  format: 'json' | 'sse' | 'ndjson';
}
export interface ProviderTransformInput {
  phase: 'request' | 'response' | 'frame' | 'end';
  input: unknown;
  state?: unknown;
}
export type ProviderTransformOutput =
  ProviderRequestPlan | { state?: unknown; events: ProviderEvent[] };
