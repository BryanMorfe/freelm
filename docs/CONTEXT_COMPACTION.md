# Chat and Code context compaction

Each chat-capable model has one optional catalog setting, `contextWindow`,
shared by Chat and Code. Configure its token limit under Settings → Personal →
Configuration → Models.

Code's compaction percentage and remaining-token reserve are global settings
under Settings → Personal → Code. These settings apply across Code models and
tasks in the workspace. The effective trigger uses the selected model's context
window:

```
min(floor(contextWindow * thresholdPercent / 100),
    contextWindow - reserveTokens)
```

For example, a 128,000-token context window, 90% threshold, and 32,000-token
reserve compact at 96,000 tokens used. The reserve is headroom for the next
response and tool results; it is not an output-token parameter sent to the API.

Unconfigured models use a clearly marked FreeLM fallback context window of
128,000 tokens. This is not a claim about a discovered model's actual capacity.
Code's default policy is 90% with 32,000 tokens reserved. Chat uses that fixed
default policy and does not inherit the Code settings.

If the reserve is at least the selected model's context window, the effective
reserve falls back to 25% of that window, rounded down. The global setting stays
unchanged for other models. Explicit settings require a positive integer window,
an integer percentage from 1 through 99, and a nonnegative integer reserve. A
reserve of zero is supported.

When upgrading existing settings, FreeLM migrates the legacy policy from the
active connection's default chat-capable model into the global Code policy. If
that model has no explicit policy, the first configured policy in connection
and catalog order is used. Missing fields use the defaults. An existing global
Code policy takes precedence. Legacy percentage and reserve fields are removed
from every model; context windows, conversation history, and checkpoints remain
intact.

Connected workspaces use the remote instance's global Code policy. Older FreeLM
hosts keep their existing model settings until updated; the new Code controls
are disabled because those hosts cannot persist the global policy.

## Portable continuation

FreeLM follows the portable, model-generated checkpoint approach in the
[OSS Codex CLI local compaction implementation](https://github.com/openai/codex/blob/dde5f8c5ae9b644c6882b3a48581ac317255d597/codex-rs/core/src/compact.rs),
reviewed at commit `dde5f8c5ae9b644c6882b3a48581ac317255d597`. The checkpoint
prompt is independently phrased for FreeLM.

Before a model request, including continuation after tools, FreeLM checks the
active context against the configured trigger. It requests a tool-free summary
from the selected model through the connection's normal Responses or Chat
endpoint, preserving the selected thinking mode and base system instructions.
It then continues with recent user requests and the continuity summary.
Retained user text has a 20,000-token ceiling and a smaller budget when needed
for the configured window. The normal system prompt and current tool catalog
are included again on subsequent requests.

There is no dependency on `/responses/compact`, encrypted compaction items,
or an OpenAI-specific backend capability. Both streaming and compatible
nonstreaming responses are accepted. A backend that explicitly rejects Chat
streaming usage metadata is retried without that optional field.

The UI shows **Compacting context** while this request runs. The successful
checkpoint changes only the model's active context: original messages, tool
records, generated assets, and activity history remain available. A completion
record appears in the expandable activity history.

## Accounting, recovery, and persistence

FreeLM uses the latest provider input-token count when available, adjusted for
context added since that request. Otherwise it estimates text from UTF-8 bytes
divided by four, rounded up, with bounded media estimates. Tool schemas and the
system prompt count toward the context budget. Estimates are not exact
tokenization, particularly for multimodal inputs. Provider usage samples are saved
with their exact conversation path, connection, and model, so a matching sample
can also guide the next user turn after reopening the conversation.

An explicit context-overflow error triggers compaction and one retry of that
model request. If the summary request also exceeds context, oldest protocol
items are progressively removed from its input together with paired tool calls
and results, while retaining the latest user request. No tool executes during
summarization or before retrying a rejected model request.

A checkpoint is committed only after a complete, nonempty, tool-free summary
that reduces context below the trigger. Cancellation or summary failure leaves
the previous model context and all original history intact. If a summary cannot
free enough room, the UI reports the error instead of repeatedly compacting
without progress.

Saved checkpoints are bound to their exact conversation path, connection,
model, endpoint, and original transcript offset. Reloading can reuse a matching
checkpoint and replay only later messages and protocol items. Edits, branches,
and regeneration ignore checkpoints whose preceding message IDs do not match.

Model/tool continuation has no fixed turn count or cumulative tool-call limit.
Tool-output budgets reset each model round. Per-response malformed-data,
per-result output, and overall storage-size protections still apply; these are
resource bounds rather than a limit on the number of agent steps.
