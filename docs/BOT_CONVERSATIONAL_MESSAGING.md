# Conversational Bots delivery audit

This change extends the existing runtime; it does not introduce a second messaging channel.

## Existing mechanisms retained

- `electron/bot-runtime.ts` registers `bot_send_message` with only a bounded `text` argument. `BotHost.respondOwned` registers it each tool-capable round and rejects extra fields. The model cannot select a recipient or host.
- `electron/bot-host.ts` binds delivery to the current reply job. `commitSentMessage` checks the conversation, pending reply and notification identity, inserts before the pending final reply, and deduplicates by durable action ID. It does not mark the run complete.
- Before delivery, the run checkpoint saves `sent`. `write` atomically persists the mailbox before `onChanged`. Main/preload forward `freelm:bots-changed`; `BotsFeature` reloads snapshots with a trailing refresh to avoid losing updates arriving during a read. `BotsWorkspace` renders ordinary completed message bubbles and a separate pending typing bubble.
- The normal final result completes the pending reply. Empty/silent notification turns remain supported. Guidance encourages a final summary but does not fabricate one when a provider returns none.
- Saved runs replay intermediate messages; mailbox IDs suppress duplicate insertion. Remote SSE transports activity/message/result separately. The client deduplicates identical IDs, rejects changed payloads for a repeated ID, and retains streamed messages in the final result. Older peers receive the existing compatibility result. Reconnect is recovery/retry plus snapshots, not a claim of exactly-once network transport.
- Existing authenticated instance routes and runtime grants remain intact. Current-conversation messaging is distinct from authorized group outreach. Group prompts exclude unrelated private recollection; this change grants no additional data access.
- New private inputs use durable steering and can abort inference; source edits/revocation invalidate old work. Cancellation and failures clear pending activity; already committed intermediate messages remain. Tool exceptions return through existing tool-result/error handling.
- Both Responses and Chat-compatible APIs use the same system guidance and provider parser. Providers explicitly rejecting tools fall back to ordinary final replies. Nonstreaming providers cannot show truthful live argument-stream typing.

## New changes

- Prompt guidance explicitly retains concise, natural final completion responses, discourages repeated progress and unjustified verbosity, and preserves failures/uncertainty.
- Provider streaming recognizes `bot_send_message`, including split Chat tool names, as writing. Arguments are never exposed as partial messages. Existing run activity transitions clear writing before tool execution and at failure/cancellation/completion.
- Bots keeps Send during bot work. Normal Chat/Code components and underlying cancellation commands remain unchanged.
- Bots reuses `DictationButton` and existing dictation configuration. Transcript insertion preserves draft text; sending uses the updated draft. Conversation scope guards stale transcripts. No new speech service or permission is introduced.

## Evidence and limits

Deterministic tests cover split tool names/arguments, multiple calls, truncated streams, typing cancellation/failure, durable intermediate delivery before a gated next inference step, final ordering, duplicate requests, mailbox reopening, and preservation of progress on later inference failure. Existing runtime recovery, steering and authenticated loopback transport suites also pass.

Cached Playwright Chromium was absent, but installed Google Chrome supports disposable-profile QA. Initial dev-server runs failed the completion transition and timed out navigating to dictation setup. Diagnostic timestamps showed the completed snapshot returned within 97 ms; browser instrumentation then confirmed snapshot application and rendering of completed content. The same run logged unrelated `WelcomeOnboarding.tsx` hot reloads from concurrent preview work. The failure snapshot eventually contained the completed text: this was not evidence of lost final-message state.

The validation route was corrected to serve the already-validated `dist` with `vite preview` on isolated port 5197 (no shared build or HMR), using installed Chrome and one Playwright worker. Both unchanged tests passed: writing → completed → pending → failed → unsent lifecycle, and dictation setup/dismissal. Assertion deadlines were not extended. Temporary diagnostics were removed; no application fix was necessary. Six additional static-preview regressions passed: send failure/retry without duplication; completion and no replay on refresh/reactions; background-work composer/approval routing; normal Chat transcribe-and-send exactly once; cancellation/navigation/late transcription results; microphone denial and transcription failure preserving drafts. A ninth focused check passed for busy Bots: Send click and Enter each submit once, the active reply stays pending, no stop command is issued, and empty input retains disabled Send. All nine targeted frozen-build browser checks passed. All audio and provider responses were mocked. The evidence supports dev-server interference/timing, not a reproduced product defect.

Computer Use inventory exposed no browser surface. This evidence is scripted browser automation plus screenshot inspection, not native Computer Use. No actual microphone capture occurred. Follow-up read-only inspection found the separate native client in `../FreeLMBots` (the umbrella description was stale). Its `BotMessage.activity` is an optional string; snapshot polling and `ActivityDots` already accept `writing`, and its composer does not swap Send to Stop during bot execution. No protocol or decoder change is required. Short typing phases may be missed between polls. No native iOS runtime/UI test or iOS dictation change was performed.

The owner app, Nova settings/history and onboarding preview files were not touched. After the owner reported normal shutdown, installation completed with a recoverable `/Applications/FreeLM-backup-20261025-192438.app` backup. Installed content/signature/fuses/ASAR were verified and `/Applications/FreeLM.app` launched normally; see `release/qa-20261025-bots-sunlit/installation.json`.
