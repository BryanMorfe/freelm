# Desktop failure recovery

The main process owns renderer recovery. Unexpected renderer termination (`crashed`,
`oom`, `killed`, launch failures, and other Electron exit reasons) cancels only work
owned by that renderer. It clears its plugin surfaces, previews and workspace
transfer handles, releases remote leases, persists interrupted chat/tool state,
and waits for storage before loading a fresh renderer. Host-owned Bots, scheduled
work and peer sessions keep their existing single execution ownership.

The renderer gets two automatic reloads, after 500 ms and 2 seconds, within a
rolling two-minute window. A successful load does not erase that budget. The third
failure, failed/timed-out cleanup, or repeated load failure opens a native recovery
dialog independent of React. Manual reload retains the crash budget. Closing the
window or quitting cancels recovery timers. Unsaved renderer-only drafts/stream
chunks cannot be reconstructed after process death; previously persisted state
remains authoritative. Failure to persist cleanup prevents automatic reload.

Recovery never resubmits a chat, provider request, tool call, payment or queued
side effect. Existing recovery marks partial messages and running tools interrupted;
Code goals await explicit resume. This is not a response to slow inference or a
long model load. No timeout of a provider request triggers renderer recovery.

The bundled search helper is safe to recreate independently. After unexpected
exit while running, its manager starts a new helper after 1 then 4 seconds, with
at most two attempts in two minutes. Outstanding searches fail; queries are never
replayed. Stop, disabling search, configuration changes and application shutdown
cancel pending restarts. Startup/configuration errors are exposed normally rather
than retried indefinitely. Settings → Search provides the manual Start fallback.

Provider/plugin interpreters, custom nodes, PDF/image transforms and orchestration
workers are operation-scoped. Existing containment rejects/cancels the failed
operation, terminates resources and permits a fresh worker for a new explicit
operation. Stateful interpreter sessions are not transparently reconstructed or
replayed. Bot/workflow/scheduler hosts in the main process are not recreated on an
arbitrary exception: their ownership, persistence and side effects require normal
failure handling. Embedded browser pages already expose their own Reload fallback.

Main-process termination, OS termination, GPU/driver failure and machine failure
are outside automatic recovery. FreeLM does not install an external watchdog or
claim it can recover its own main process. A subsequent normal launch uses the
existing durable interruption recovery. JavaScript render exceptions and UI hangs
are also distinct from native renderer termination; this mechanism does not
reload on every console error or long-running request.

Native recovery events are written to `<FreeLM home>/logs/recovery.jsonl`, with one
rotated previous file (roughly 64 KB each). Events contain only time, component,
event, bounded reason token and exit code—no prompts, credentials, provider URLs
or worker payloads. Search also retains its existing redacted service log.

## October 31 investigation

The installed Electron 44.4.5 renderer terminated with SIGTRAP at 01:29:14 UTC.
The authorized single live hi replay completed at 02:00:46 UTC, 539.791 seconds after submission, with an 803-character saved response and no error or renderer termination. The diagnostic script admitted one inference request and blocked its automatic title/memory requests. A separate user-authored follow-up began at 02:03:19 UTC and completed at 02:03:40 UTC; it was not sent by the diagnostic script.
Native diagnostics reported `Near V8 cage limit`, with 1838.6 MB used heap; a read-only
CDP counter measured 1881212772 bytes used. The owner media directory contained
1837438948 bytes. `MediaStore.hydrate` currently restores all referenced strings,
and bounded IPC still transfers the complete hydrated workspace into the renderer.
This is concrete memory pressure and a follow-up target for lazy media loading;
it does not establish the exact allocation that caused the original SIGTRAP.
Changing the model default and sending hi against a synthetic localhost provider
succeeded in the same installed bundle. Neither a DeepSeek protocol defect nor a
complete fix for the original memory pressure is claimed by this recovery change.
