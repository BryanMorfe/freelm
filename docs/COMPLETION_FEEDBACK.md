# Completion feedback

FreeLM submits completion feedback after durable successful work in Chat, host-owned Code,
Bot conversations and top-level workflow runs. Failed/cancelled runs remain quiet. Explicit
workflow notification nodes and scheduled reminders retain their existing behavior.

## Attention and privacy

- The existing **Background notifications** preference controls ordinary completion banners.
  Banners are suppressed while the app is focused. Existing explicit scheduled Bot replies
  remain eligible for a banner in the foreground and with that preference off.
- Bot banners use a generic title/body; they do not expose response contents. Chat retains
  the existing conversation-title behavior. Workflow completion uses a generic title/body.
- **Bot response sound** defaults to enabled at 100% when no preference is saved. An explicitly
  saved mute or volume is preserved. When enabled,
  a 140 ms message cue plays in the foreground and the existing chime plays in the background,
  provided Background notifications is on. Muting or zero volume prevents playback.
- A single durable receipt selects one sound route after preferences and persistence resolve. Rapid arrivals share a 750 ms audio cooldown, including across focus changes; suppressed sounds are never queued. The renderer drops a cue if its focus no longer matches. Incoming intermediate and final completed messages use this route; outgoing sends stay silent.
- Bot OS banners are silent: the renderer is the only Bot chime playback path. Other OS
  notification sound behavior is unchanged. No sound is queued if the renderer is absent
  or not ready. OS/output mute and playback failures can prevent audible delivery.
- **Preview chime** is an explicit user action and can preview a nonzero volume even when
  the completion sound or Background notifications is off. Preview errors are shown inline.
  Settings use the normal Save, Keep editing and Discard changes flow.
- Audio is original procedural synthesis; see
  [asset provenance](../src/assets/bot-response.PROVENANCE.md). No proprietary sound was copied.

## Identity, persistence and navigation

Events identify the owning host, saved workspace profile, entity kind/ID and run/message ID.
A serial coordinator reserves a hashed receipt before submitting effects. The last 10,000
receipts survive restarts; aliases for the same host/run deduplicate. Receipts contain no
message text, title or raw destination. Damaged receipt storage fails closed without replacing it.

This guarantees bounded at-most-once **submission**, not OS delivery or user receipt. A crash
between reserving a receipt and submitting a notification can lose that alert. Unsupported or
failed OS submission is recorded in coordinator diagnostics; it is not replayed later.

Clicks verify the current host/profile mapping, switch to the owning workspace and select the
exact conversation or workflow run. Removed/replaced hosts and unavailable entities show an
error rather than opening a same-ID item elsewhere. Unsaved Settings retain the existing exit
confirmation. Renderer readiness also handles clicks while a window is opening/reloading.

This batch does not add notification fan-out across peers. Host-owned Bot and workflow
notifications originate on their owning desktop. Remote-workspace Chat completion originates
on the requesting client. Cross-device notification policy remains part of the peer roadmap.
Workflow click routing currently uses the existing recent-run snapshot; an older/pruned run
can be unavailable and is reported rather than silently opening a different run.

## Bot presentation

All four message-bubble corners use the existing 19px radius, without asymmetric overrides or
a tail. The existing message-arrival animation is retained: it tracks newly arriving message
IDs, excludes initial/history replay and honors reduced motion. Token updates are not new
arrivals. This batch diagnoses and verifies that behavior rather than adding a second animation.

## Verification boundaries

Unit tests cover durable deduplication, focus/master/mute/volume policies, failures/cancellation,
provider-independent producers, persisted preferences and exact destination matching. Browser
fixtures exercise settings, keyboard preview/error retry, navigation and unsaved-draft protection.
Native QA uses a separate disposable profile, a localhost synthetic inference server and
intercepted Electron notification/audio submission. Such assertions do not verify OS delivery,
notification permission state or heard audio. No owner data or OS permissions are changed.

## iOS foreground messages

iOS plays the new foreground cue only while active, retaining shared mute/volume defaults and saved choices. Scene epochs discard refreshes spanning an app switch; the first snapshot after resume establishes a silent baseline. Concurrent refreshes per host are excluded, reconnect refreshes stay quiet, and the audio gate coalesces bursts. The existing iOS client has no background push notification route. Settings previews explicitly distinguish message and background sounds.

## App icon unread badge

The desktop badge counts unique unread completed incoming messages in the local Bot mailbox, derived from each conversation's durable `readAt`. It includes intermediate and final messages, excludes pending/failed/outgoing messages, and includes attachment-only replies. It is recomputed on mailbox changes and startup; no counter or separate receipt store is persisted. Read/removal changes reduce the count, including to zero. Unfocused conversations are not automatically marked read. Sound mute and notification-sound preferences do not change unread counts. Electron's native badge API respects OS notification permission; this feature never requests permission.

Scope limits: remote workspaces, Chat and workflow completions do not yet share this unread model. iOS has no read-marking endpoint and no durable user read state in its current client model; an iOS icon badge is deferred rather than adding a divergent local counter. No background push infrastructure is added. Actual Dock/iOS badge appearance requires separate observation with existing OS permission; unit checks validate derived counts, not OS presentation.
