# Experimental provider adapters

Local desktop connections can select an installed provider adapter and account in
Settings → Configuration. Chat, Code, Bots and plugin text inference use the same
host-side adapter route. Built-in providers retain their existing transports.
Adapters translate canonical text/tool input and emit canonical events; a compatibility
bridge preserves existing Chat Completions transcripts and tool loops. This is not
live-provider certification; the supplied Messages example is synthetic.

To configure an adapter, review/install its package, connect an account, and enable
account access for Chat, Code or individual Bots in Plugins. Installation requests
`provider.use`; selecting a connection never grants account access. In Configuration,
select the provider/account, endpoint and credential header, save, and manually add
model IDs with **Standard** thinking. No model discovery request is sent. API keys
use existing host secret storage; plugin code never receives them. A missing,
disabled or ungranted adapter fails with an error, without protocol fallback.
No owner installation, accounts or grants are changed by the synthetic tests.

Local API v2 packages can declare `contributes.providers`:

```json
{
  "providers": [{
    "id": "unconventional",
    "name": "Custom endpoint",
    "capabilities": { "tools": false, "streaming": false }
  }]
}
```

The enclosing manifest must request `provider.use` in `permissions.capabilities`
and list exact API origins in `permissions.network`. These declarations alone do
not authorize execution. `PluginHost.generateWithProvider` verifies the enabled
package, account, surface/bot grant, explicit granted capability, account version,
and package hash. Account cancellation interrupts host fetch and sandbox workers.
This implementation does not grant any real permission.

Export `definePlugin({providers: {unconventional: transform}})`. The SDK handler
receives `{phase,input,state}` and has no fetch, storage, filesystem, credential,
or inference context. Handlers must be synchronous. One bounded QuickJS realm is
created per request and reused for its frames, then terminated. State can be returned
explicitly as JSON; no state survives between requests. Async transforms are rejected.

The authoritative types are `src/provider-types.ts`:

- `request`: canonical version-1 text/tool input → `{path,headers?,body,format}`.
- `response`: `{status,body}` for JSON replies and HTTP errors → `{state?,events}`.
- `frame`: `{event,data}` for SSE or NDJSON → `{state?,events}`.
- `end`: EOF → `{state?,events}`. EOF without a terminal event fails.

The host owns POST transport, relative-path validation, exact origin restrictions,
redirect refusal, and credential insertion. Supported host credential headers are
`authorization` and `x-api-key`. Plugin-set headers are limited to `accept`,
`anthropic-version`, and `anthropic-beta`. Credentials never enter request
transformation inputs; known complete reflected secrets are redacted in bridge
payloads and errors. Redaction is not a general data-loss-prevention guarantee.

Version 1 supports ordered text messages, system instructions, tool definitions,
assistant calls and correlated tool results. Events normalize text, tool argument
fragments, measured input/output token counts, completion, and failures. Missing
usage is unknown. Duplicate/unknown tool IDs, unknown tool names, malformed final
arguments, incomplete batches, invalid usage and post-completion events fail.
Consumers must execute tools only from a successfully completed result, never from
provisional stream events. Adapter code never approves or executes tools.

Limits: 512K-character input, 1 MiB HTTP response, 1 MiB per worker JSON payload,
2 MiB normalized event payloads, 128 calls, 256 KiB arguments per call, 16,384
transformations, 100 ms CPU and 5 seconds wall time per transformation, and 120
seconds total. Frames are awaited sequentially with bounded network slices.
Only one transformation is in flight per session; at most eight sessions run.
The worker also enforces an aggregate CPU window. A 200-frame synthetic regression
checks that a session retains its realm without spawning a worker for each frame.
Cancellation stops local work; it does not guarantee remote work or billing stopped.

Synthetic examples are in `examples/plugins/provider-adapters/`. The example folder contains a package manifest and SDK entry, but remains
experimental and is not activated or installed by the tests. The Messages example implements only the
fixture's text/tool streaming subset, not all provider content blocks or stop
reasons. Tests bundle these examples and the actual sandbox worker into a disposable
directory and supply fake fetch responses; they make no provider calls.

## Supported boundaries and deferred features

Local text, tool round trips, stream display, cancellation and measured token usage
are integrated. Text-only nonstreaming adapters also work in streaming consumers:
the host negotiates JSON output and delivers the validated result through the same
compatibility stream. Tool calls are released only after the adapter completes.
Strict tool hints are preserved for the adapter; FreeLM still validates tool input
and retains existing tool authorization independently of provider schema guarantees.

Remote workspaces and remote Bot callers explicitly reject adapters. Browser-only
preview cannot execute them. Media endpoints, vision, model discovery, structured
output, reasoning control, opaque provider replay metadata, retries, queue jobs,
WebSockets and custom signing are deferred. Unsupported model features and request
options fail before transport. Use Standard thinking with manual model configuration.
Automatic Bot memory extraction and automatic Code approval review require contracts
not supported by this MVP; they fail closed. Code's existing Ask permission mode
remains available. No change to owner permission settings is made.

The built-in OpenAI protocol implementations were not broadly rewritten. The
canonical compatibility bridge is limited to adapter connections; existing built-in
regressions verify their prior behavior. There is no automatic retry of failed
adapter requests and no fallback to a built-in endpoint.

Focused verification:

```sh
npm test -- tests/desktop/provider-adapter.test.ts tests/provider-routing.test.ts tests/provider-adapter-settings.test.ts tests/plugin-manifest-v2.test.ts tests/api.test.ts tests/agent.test.ts tests/desktop/bot-provider-stream.test.ts tests/desktop/plugin-inference.test.ts
```
