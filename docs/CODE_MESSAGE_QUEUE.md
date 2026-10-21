# Code message queue

While a Code task is running, the composer stays editable. An empty composer
shows Stop; entering text or attaching a file replaces it with the ordinary Send
button. Send or Enter clears the composer and stores the follow-up in the drawer
above it, then Stop returns. Attachments, queued-message editing, the model and
thinking chooser, and local permission controls remain available during work.
Host-managed permission controls retain their read-only restriction.

Changing the model or thinking mode leaves the current request intact; the next
queued user-input segment uses the new choice. Permission changes apply to
subsequent tool checks. A pending Ask approval is released after the new mode is
persisted. An automatic review already in progress finishes before its stale
decision is discarded and the action is checked again under the latest settings.
The action can execute only after that new check permits it.

The drawer shows a one-line preview, attachments, editing, and removal. Clicking
the preview expands it. Chat continues to accept one request per thread at a
time; its next draft remains editable.

The Code composer also remains available while an assistant question or tool
permission waits above it. Sending a follow-up queues that text; it does not
answer the question, grant permission, run the tool, or advance the provider
request. Use the question's Send or Skip action, or the permission's explicit
approval or decline action. Each task keeps its own pending question, permission,
queue, and draft when navigating between tasks.

Assistant questions appear in a sheet above the composer without blocking
navigation or keyboard focus. Minimize question collapses it to a Question
button; reopening preserves the selected options, custom answers, and current
page. Multiple questions use Previous and Next. Next requires an answer for the
current page, and Send appears on the final page and requires every answer.
Neither paging nor minimizing submits an answer. Skip explicitly submits an
empty answer set for that task only.

FreeLM delivers queued Code inputs in submission order at the next safe model
request boundary: after the current response and every tool call it issued have
finished. It never interrupts a running command or separates a tool call from
its required result. If that response contains no tools, delivery follows its
completion. New input continues with the same execution run, so command sessions
and discovered tools remain usable. Compaction checkpoints also remain tied to
their exact preceding conversation path.

Queued inputs are stored separately from committed messages, with stable IDs.
At delivery, a complete assistant transcript segment and the queued user inputs
are committed before the next request. The drawer entries leave the queue in the
same state change. The final response belongs to a new assistant message after
those inputs. Input already committed to history is never replayed from a stale
queue entry.

Editing a queued message pauses delivery until Save or Cancel; it retains the
message's position and restores the previous composer draft. Navigating away
cancels that editing session and preserves the queued entry. Navigating between
tasks keeps each queue and draft with its original task. Stop, request failure,
or reload leaves unconsumed queue entries available. Reload does not execute
them automatically: use Send in the drawer, or send a new prompt to resume.
Branches do not inherit their parent task's pending inputs.

If the model request fails after queued inputs have been committed, the drawer
keeps a failed-follow-up row with the error and Retry. This row refers to the
existing user-message IDs; it is separate from inputs still waiting in the queue.
Retry continues from the saved conversation and complete tool transcripts,
including results produced within the failed assistant segment. It does not
append another copy of the queued prompt or rerun completed commands. New
pending inputs wait for the next complete response and tool batch as usual.

Repeated failures update the visible error. Stop and reload preserve the failed
record and unconsumed inputs without restarting them automatically. A successful
continuation clears the recovered failed-follow-up row.

The portable boundary behavior was checked against the
[OSS Codex input drain](https://github.com/openai/codex/blob/dde5f8c5ae9b644c6882b3a48581ac317255d597/codex-rs/core/src/session/turn.rs#L419)
and its tool drain and pending-input tests at commit
`dde5f8c5ae9b644c6882b3a48581ac317255d597`. In Codex terminology this resembles
deferred steering; its UI's ordinary Queue action instead waits for an entire
turn to finish. FreeLM uses the next-tool boundary requested for this feature.
No proprietary response-steering endpoint is required.

Validation includes both provider protocols, persisted private workspaces,
FIFO delivery, edits and deletion, attachments and quoted context, navigation,
actual text and reasoning stream deltas, question-sheet minimization and paging,
keyboard navigation, explicit permissions,
failed continuation retries, Stop/reload, and native command-session continuation
against a loopback mock provider. Native permission and retry checks use only
synthetic markers inside a private temporary workspace. Real inference-server
behavior is not covered by those fixtures.
