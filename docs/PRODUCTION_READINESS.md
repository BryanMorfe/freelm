# Production-readiness roadmap

Audit date: 2026-10-23. Scope: Bryan's seven-area request, plus font portability
and semantic-color consistency. This is a proposed roadmap, not implementation
approval or a claim of production readiness.

Source: `https://github.com/BryanMorfe/freelm.git`, branch `main`, base commit
`95fc3cee2048cd9da8bb952982aa31784510ba39`, including the existing uncommitted
provider, setup and Plugins improvements. Preserve those changes. The app is
Electron/React/TypeScript; current instance access is host-authoritative. Apple's
design language and the existing shared shell remain requirements; see
[UI guidance](UI_GUIDELINES.md).

## Evidence and limits

This pass inspected code, existing tests and current official Google documentation.
It ran 12 existing fixture test files: **141 passed, 0 failed, 0 skipped** in
11.08 seconds. Command:

```sh
npx vitest run tests/bot-message-appearance.test.ts tests/workflow-notifications.test.ts tests/desktop/bot-notifications.test.ts tests/desktop/bot-notification-boundaries.test.ts tests/remote/client.test.ts tests/remote/host.test.ts tests/remote/manager.test.ts tests/remote/renderer.test.ts tests/workspace-merge.test.ts tests/workspace-patch.test.ts tests/plugins.test.ts tests/appearance.test.ts --maxWorkers=1
```

These are synthetic/provider-fixture, host-boundary and state tests. They do not
prove Google integration, visible OS notifications, physical cross-device behavior,
or frame-rate/large-history performance. Browser tests were inspected, not rerun
in this documentation pass. No build or full-suite rerun was needed for these
Markdown-only changes. The prior plugin tranche's full suite/build/native evidence
remains historical evidence, not a new seven-area qualification run.

No owner accounts, OAuth registrations, permissions, mail/calendar writes, paid
inference, commits or publication were used. No owner data or credentials changed.

## Gap matrix

Priority meanings: P0 = architectural/product decision needed before promising the
feature; P1 = user-facing readiness gap; P2 = polish/consistency after core gates.

| Area | Verified foundation | Remaining gap | Priority and dependency | Release acceptance |
|---|---|---|---|---|
| 1. Gmail + Calendar plugin | Host-owned OAuth/PKCE, encrypted credentials, local plugin authenticated fetch, account/tool/Bot grants and approval hints | No Gmail/Calendar adapter in bundled examples/catalog; Google registration is still pending per owner; Google-specific auth and API behavior unqualified | P1; choose initial tool/scope set, qualify Google auth, then owner-led app setup and separately authorized live qualification | Fixture and live evidence separately recorded; exact account/tool grants; safe draft/send/event behavior; renewal/revocation and ambiguous-write recovery |
| 2. Completion notifications | Renderer Chat completion IPC, explicit workflow notify node, scheduler OS notifications, durable internal Bot/workflow completion queues | Incomplete host-task/Bot/general workflow OS coverage; no unified preferences, routing, deduplication or delivery diagnostics | P1; common completion identity and destination contract before wiring producers | One appropriate alert per terminal run, correct destination after workspace switch/restart, denied/unsupported/focused states observable, Mac/Linux visible delivery verified |
| 3. What's New / onboarding | Existing dialog/settings components and setup shortcuts | No dedicated versioned What's New feature found | P1 dependency gate: Bryan supplies visual design/content; lifecycle contract can be specified first | First-run/update/manual-open behavior, durable seen version, cancel/reopen, offline operation, accessible focus; no forced setup wizard |
| 4. Bot message feel | New-arrival 240ms animation, typing/thinking states, reduced-motion guard, history/reaction replay tests | 6px corner overrides remain on 19px bubbles; perceived smoothness still needs native validation | P1 small fix; reuse existing arrival bookkeeping and shared motion work | Uniform radius in every direction/group state; arrivals animate once, old history does not, reduced motion respected, no scroll jumps |
| 5. Shared motion | Several local transitions/keyframes and reduced-motion overrides | No shared motion specification; coverage uneven, including workflow/tool spinners without local reduce overrides | P2; inventory then narrow component adoption | Consistent durations/easing, interruption/reversal, keyboard/focus continuity, reduced-motion coverage and measured frame cost |
| 6. Long histories | Immutable updates, memoized components, grouped Code activity, existing storage/serialization optimizations | Chat/Code mount all messages; Bots filter/map full history; closed activity groups still render children | P1; stable turn grouping and scroll anchors; separate rendering from storage pagination | Bounded initial rendering and bounded heavy children, older-history loading without jumps, streaming/edit/reply/search correctness, 1k/10k-turn fixture benchmarks |
| 7. Multi-instance synchronization | Authenticated loopback host, SSH/TLS client transport, pinned host identity, encrypted saved tokens, CAS revisions, remote tools/assets | Remote access is not replicated/offline-first sync; missing peer trust lifecycle, resumable replication, conflict/deletion policy, broad resource coverage and real-device qualification | P0 architecture decision, then P1 staged delivery; no hosted user-data storage | Mac/Linux convergence, offline catch-up, revocation, conflict/deletion correctness, resumable attachment integrity, explicit resource/settings policy, later Pi/mobile validation |

## 1. Gmail and Calendar: build on the plugin boundary

Evidence: [plugin contracts](../src/plugin-types.ts),
[OAuth](../electron/plugins/oauth.ts), [host](../electron/plugins/host.ts),
[plugin tests](../tests/plugins.test.ts), [plugin docs](PLUGINS.md), and
[examples](../examples/plugins). The four current examples are Notebook, Follow-up,
Selected Text Tools and Attachment Drawer. No Google mail/calendar package was
found. Remote account administration and remote plugin access remain intentionally
restricted; do not silently relax these to satisfy eventual mobile access.

Gmail and Calendar are separate APIs/scopes. Propose one user-facing Google plugin
with separately described mail/calendar tools and grants; confirm packaging choice
before implementation. Start with message/thread search/read, event list/read,
mail draft creation and event creation. Sending, modifying, deleting and broad
mailbox/calendar management are separate capabilities, not implied by read access.
The eventual breadth requested by Bryan should be an explicit capability checklist,
not a promise of parity with an unspecified external integration.

Google's official [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
classify mail read/compose/modify scopes as restricted and send as sensitive.
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) separately
cover event reading and event editing. Choose minimal scopes for the accepted tools;
review applicable verification requirements before public distribution. This pass
neither registers the app nor grants any scopes.

[Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
requires appropriate API/client configuration and supports the system-browser,
loopback/PKCE flow. Existing FreeLM code is a starting point, not qualification:
`connectOAuth` replaces authorization URL query parameters with its fixed set and
has no `access_type=offline` option. Token parsing rejects extra returned scopes
but does not retain a granted-scope set for per-tool partial-consent gating. Local
plugin authenticated fetch is restricted to one exact `apiOrigin`, with 1 MiB
request/response bounds. Prove the selected Google endpoint origins, refresh-token
behavior, consent/reconnect flow and attachment sizes without weakening those
boundaries indiscriminately.

Acceptance:

- Contract fixtures for paginated mail/calendar results, Unicode/MIME, attachments,
  time zones/DST, recurring events, missing scopes, expired/revoked tokens, 429/5xx,
  refresh races and cancellation. Mail body/attachment content remains untrusted.
- Exact Code/Bot grants checked again at execution. A draft is distinguishable from
  a sent message. Event attendee invitations and update notifications are explicit
  effects. Human approval/automation policy for writes is agreed before live use.
- Stable local operation identities and reconciliation for uncertain sends/creates;
  no blind retry that sends duplicate mail or invitations.
- Owner-led Google project/API/consent/client setup follows fixture qualification.
  A separately authorized test account and bounded live test then verify actual
  read/draft/send/event behavior; tokens never enter prompts or diagnostics.

## 2. Notifications: distinguish internal events from OS delivery

Evidence: [renderer completion](../src/App.tsx) (`notifyCompletion`, around 2520),
[main process](../electron/main.ts) (completion IPC around 809; host completion
around 1155; workflow adapter around 1216; scheduled Bot reply around 1290;
scheduler notification around 1479),
[workflow receipts](../electron/workflows/notifications.ts),
[Bot runtime](../electron/bot-runtime.ts),
[workflow tests](../tests/workflow-notifications.test.ts) and
[Bot notification tests](../tests/desktop/bot-notifications.test.ts).

- Renderer completion requires success, non-abort, unchanged active workspace and
  enabled background notifications. Main suppresses it whenever the window is
  focused, even if another conversation is visible. Its click payload contains only
  `threadId`; App searches the current workspace. It cannot reliably identify a
  destination across host/workspace switches or equal IDs on different hosts.
- Host-owned Code completion emits `thread.completed` to workflows; that callback
  does not itself create an OS notification. Do not count renderer Chat coverage
  as blanket host-task coverage.
- Workflow `notify` nodes call Electron explicitly, but that is not automatic
  completion for every run. Durable workflow completion receipts enqueue a source
  Code-thread prompt; they are not OS delivery receipts.
- Bot task/reaction notifications are largely durable internal wake-ups/messages.
  Scheduled Bot replies do call the scheduler OS path. Ordinary incoming Bot replies
  and all terminal jobs do not share a general OS notification policy.
- `Notification.isSupported()` and `.show()` are present; no unified failed/show
  event diagnostics, denied-permission UX, notification center or per-run durable
  OS delivery ledger was found. OS acceptance is not proof the user saw a banner.

Design a common event `{hostId, workspaceId, entityType, entityId, runId, outcome}`
plus privacy-safe display text. Deduplicate by run/outcome, not title. Preserve
separate attention, success, failure and cancellation policies. A notification
click resolves the owning workspace and entity, or explains that it was deleted or
is offline. Do not put email bodies or other private task output on a lock screen
by default. Define whether a focused window on another page receives in-app or OS
feedback. Unify settings without changing OS permissions automatically.

Acceptance matrix: Chat, host/remote Code, Bots and workflows; success/failure/
cancel/input-needed; focused-current/focused-other/background/minimized; disabled,
unsupported, permission denied and OS suppression; duplicate event/restart; deleted
or offline destination; same IDs on two hosts. Fixture tests prove routing and
policy. Signed Mac and actual Linux desktop checks must separately prove banner
appearance and click navigation with explicitly authorized permission setup.

## 3. What's New: design belongs to Bryan

No dedicated `WhatsNew`/release-note/onboarding screen or version-seen persistence
was found in `src`, `electron` or `tests`. Existing welcome/setup states are not a
versioned release surface. Wait for Bryan's supplied design before visual work.

Specify a local bundled content schema with stable release/content IDs, a seen or
dismissed marker, manual reopening and upgrade/downgrade rules. Decide whether the
marker is device-local or synchronized, and keep it separate from an account.
Do not interrupt an active task or make onboarding a prerequisite for basic use.
Acceptance covers first launch, unchanged relaunch, upgrade, interrupted close,
back/skip/reopen, offline assets, keyboard focus/Escape, screen readers, reduced
motion, narrow layout and unknown future content versions. Scope excludes a generic
wizard or a replacement for the current Apple-style Settings.

## 4–5. Bots and coherent motion

Evidence: [arrival detection](../src/lib/bot-message-appearance.ts),
[workspace animation](../src/components/BotsWorkspace.tsx) (around 194),
[bubble CSS](../src/components/bots.css) (around 289–313),
[unit tests](../tests/bot-message-appearance.test.ts), and
[browser scenarios](../tests/e2e/bots.spec.ts) (arrival/reduced-motion tests around 875).

The current arrival animation is already opacity 0→1 plus
`translateY(8px) scale(.98)`→none, 240ms, `cubic-bezier(.22,.7,.25,1)`.
It distinguishes pending/visible messages and avoids replay on load, edit,
reaction and older-history backfill. Reduced motion skips it. The user-observed
absence therefore needs reproduction in the exact installed build and delivery
path, not a second animation implementation. Refine toward the requested iMessage
feel only after observing timing/scroll behavior; no claim of exact Apple timing.

Confirmed radius issue: base `19px` is overridden to `6px` on a lower corner for
non-consecutive incoming/outgoing messages. Remove those overrides in a future
small fix, keeping a single radius and no tail. Verify own/other, first/consecutive,
reply, reaction, typing, failed/unsent, narrow and both theme states.

Shared motion is currently component-specific: switches and chevrons have 150ms
transitions; Bots use Web Animations; several loading indicators have keyframes.
Some components provide reduced-motion rules; workflow/tool spinners do not have
local overrides. Establish restrained enter/exit/disclosure/loading duration and
easing tokens, and audit final computed styles before claiming global coverage.
Do not animate whole workspaces unnecessarily. Cover interrupted/reversed animation,
rapid repeated actions, focus continuity, streaming and reduced-motion preference
changes. Performance evidence must come from native production builds, not only
recorded calls to `Element.animate` in browser fixtures.

## 6. Bound rendering first; paginate storage separately

Evidence: [Chat](../src/components/Chat.tsx) maps `thread.messages` around 668;
[Bot workspace](../src/components/BotsWorkspace.tsx) filters all messages and maps
visible rows; [Code activity](../src/components/ActivityHistory.tsx) groups completed
tools but mounts the group's children inside closed `details`;
[state storage](../electron/state-store.ts) and [media storage](../electron/media-store.ts)
load complete workspace data. [Existing performance notes](performance-2026-09-30.md)
measured a 40-message dense history and native-vs-Rosetta behavior, not 1,000-turn
bounded rendering. Model context compaction and Bot history tools' offset/limit are
not UI pagination.

Recommended progression:

1. Build synthetic 1k/10k-turn Chat/Code fixtures, including many tool events per
   turn, large Markdown, images and a pathological single huge turn. Record native
   production DOM count, React commits, open latency, long tasks, memory and scroll
   behavior before changing rendering.
2. Render the most recent approximately 100 **turns**, not 100 arbitrary message
   records. Define grouping from stable IDs/order, including assistant/tool
   continuations and automated updates. Keep live/pending/approval content visible.
   Mount heavy collapsed activity only on expansion. Preserve full data for model
   context, exports, search, editing and branching.
3. Prepend older chunks with an explicit keyboard-accessible Load earlier control
   and optional top sentinel. Keep the first visible message ID and pixel offset as
   the anchor; correct for late image/Markdown sizing. Preserve scroll position when
   reading older content; only follow the bottom when already following. Jump to
   latest and reply/search/deep-link navigation must load the target window.
4. Chunked prepend alone eventually mounts all visited history. Add measured
   window eviction/virtualization if needed to maintain a bounded DOM during long
   scroll sessions, retaining edit/selection/focus state. Bound nested tool groups
   too; a 100-turn limit alone does not cap a giant Code turn.
5. Only then introduce persisted message indexes/cursors and media-on-demand reads
   if memory/IO/transfer measurements warrant them. This requires storage migration,
   export/backup compatibility and remote cursor/version semantics; it is not part
   of the initial render-only change.

Acceptance targets (proposed, not achieved): 1k/10k fixtures mount at most the
configured 100-turn window plus explicitly active/pinned content; heavy closed
activity children stay unmounted; prepend anchor drift ≤2 CSS px after stabilization;
no duplicate/missing IDs or changed transcript/model input. Benchmark at least 20
warm opens on declared Mac/Linux hardware: target p95 first usable render <500ms
and no history-induced >100ms main-thread stall. Record cold behavior separately.
If budgets fail, tune based on traces rather than presenting aspirational numbers
as results. Cover stream/cancel/retry/edit/regenerate/branch, nested tools, image
resizes, find/reply navigation, keyboard/screen-reader behavior and workspace switch.

## 7. Peer architecture: remote access is not synchronized replicas

Evidence: [manager](../electron/instance-manager.ts),
[client](../electron/instance-client.ts), [host](../electron/instance-host.ts),
[authority](../electron/workspace-authority.ts), [renderer storage](../src/lib/storage.ts),
[merge helper](../src/lib/workspace-merge.ts), [protocol types](../src/remote-types.ts),
[remote tests](../tests/remote), and [two-app smoke](../scripts/smoke-instances.mjs).

Current guarantees and limits:

- Host binds loopback and requires a constant-time-checked bearer token. It rejects
  browser Origin and unexpected Host headers. SSH forwarding uses system SSH with
  `BatchMode=yes` and `StrictHostKeyChecking=yes`; direct URLs require HTTPS except
  loopback. HTTPS ingress/reverse-proxy behavior is not a built-in peer network.
- Initial pairing is manual token/transport setup; a stable instance ID is pinned
  on subsequent connections. Saved tokens use the OS secret store or remain in
  memory if unavailable. Hosting generates one 32-byte session token; restarting
  hosting rotates it. There is no per-peer cryptographic identity/approval list or
  independently revocable per-device key. Removing a client-side profile is not
  host-side revocation of a copied token. Stopping hosting closes its sessions.
- WorkspaceAuthority is a single serialized writer with epoch/sequence revisions
  and stale-write rejection. Local renderer/host races have a bounded three-way
  rebase; overlapping changes fail safely. Remote saves use whole snapshots/CAS
  and do not thereby become multi-master merge. Revision epochs reset on restart;
  they are not a durable replay cursor or deletion log.
- API credentials are redacted in remote snapshots. Connections/tools and project
  directory authority remain host-controlled. Code files/Git/project roots operate
  on the owning host; a project record is not a synchronized source tree.
- Authenticated media/task-output access and Bot forwarding exist. Workflow store,
  plugin accounts, scheduler state and project filesystem data are not automatically
  part of workspace replication. Runtime streams/local host-change events do not
  constitute a resumable all-resource cross-peer event feed.
- Workspace/media files being local does not mean all user data is encrypted at
  rest: the implemented secret-store boundary protects credentials. SSH/TLS
  transport protection is not an end-to-end encrypted replicated data model.
- Existing tests cover tokens, identity, SSRF/redirect boundaries, CAS conflicts,
  credentials, routing and cancellation. SSH tests inject a launcher. The two-app
  smoke is same-Mac loopback with a mock provider, not Mac↔Linux physical networking.
  This audit did not run it. Physical machines, sleep/network partitions, Pi and
  mobile remain unqualified.

Decisions required before sync implementation:

1. Replication contract: recommend retaining an authoritative owner per resource
   initially, with local read caches and explicit offline behavior. This is a
   milestone toward Bryan's full real-time sync goal, not a substitute for it.
   Approve a multi-writer/offline edit and conflict policy before enabling writes.
2. Identity/trust: accountless device keys, user-verifiable pairing, per-device
   grants, revocation propagation and recovery after losing the last trusted device.
   Define application-level encryption/key rotation and what a revoked offline
   device can retain; already downloaded data cannot simply be recalled.
3. Data classes: separate synced preferences/content from machine paths, hardware
   choices, plugin tokens, API keys and permissions. Default to host-local secrets
   and authority until an explicit secure transfer policy is approved. Define
   whether projects mean metadata, selected files, Git repositories or all three.
4. Connectivity: LAN discovery plus user-controlled remote transport; sleeping or
   disconnected peers cannot provide fresh data. NAT traversal/optional encrypted
   transit relay, mobile background delivery and Pi always-on hosting need separate
   decisions. No hosted storage of user history/content is permitted by this scope.
   Do not silently promise serverless reachability through every network.

Staged acceptance:

- First qualify the current protocol on two real disposable Mac/Linux hosts over
  SSH and the supported direct topology: restart, dropped stream, sleep/wake,
  stale revisions, host replacement, revoked token, unavailable keychain, equal IDs
  and cross-host navigation. Document Linux ARM/Pi packaging and native dependencies
  separately before claiming support.
- Prototype replication with three disposable peers and model-based fault tests:
  durable operation IDs/cursors, at-least-once delivery with idempotent application,
  reconnect snapshots, interrupted catch-up and version negotiation.
- Concurrent edit/delete, tombstone retention/garbage collection, stale backup
  restore and offline peer return must converge without resurrecting deleted data
  or silently overwriting user changes. Surface unresolved conflicts.
- Attachments require content hashes, bounded/resumable chunks, disk quotas, access
  checks and deletion retention; corrupt/partial bytes must never appear complete.
- Test preferences/projects/workflows/Bots separately, not only Chat. Syncing a
  workflow definition must not cause every peer to execute it: keep execution
  ownership, run IDs and side-effect deduplication explicit.
- Set and measure a convergence budget (proposal: p95 <2s for small changes on an
  awake healthy LAN). Offline queued/catching-up/blocked states remain visible.
  Mobile clients later need scoped access and revocation with no local credentials
  implicitly exposed. No parity claim until a coverage matrix passes.

## Cross-cutting design and release gates

- Fonts: [root stack](../src/styles.css) is Inter, Apple/system fallbacks, Segoe UI,
  sans-serif; no UI font assets are bundled. Choose either deliberately platform-native
  typography or a properly licensed bundled font. Do not silently choose a new font
  or claim equal metrics across platforms. Test 13px minimum primary UI text, 550/560
  weight resolution, multilingual glyphs and layout on both systems.
- Colors: [shell overrides](../src/components/sidebar.css) differ from root defaults;
  [appearance settings](../src/lib/appearance.ts) customize actions/bubbles while
  green focus/accent remains fixed. Success/warning/info and selected controls use
  scattered literals. Inventory semantic roles and introduce tokens without changing
  the established palette by accident; verify light/dark contrast and custom accents.
- Preserve the shared shell, Apple-style grouped rows, keyboard access and save/cancel
  semantics. Existing [backlog](BACKLOG.md) items remain valid: provider qualification,
  Anthropic, Linux UI, loading performance and owner-selected root license. fal stays
  deferred. No root project license was found; bundled third-party licenses do not
  license FreeLM itself. Do not choose one on the owner's behalf.

## Bounded first implementation batch — proposed, not started

Recommend a **completion-feedback tranche**, split into two reviewable changes:

1. A host-owned completion-notification coordinator and fake OS adapter. Route Chat,
   host Code, ordinary Bot job/reply and workflow terminal events through stable
   destination/run identities. Preserve current security/approval behavior, unify
   background preference handling and prevent duplicate or misrouted alerts. Add
   fixture coverage for terminal states, suppressed/failed delivery, restart and
   cross-workspace clicks. Stage rollout per producer so a broken producer cannot
   hide others. No OS permission changes or real provider calls in automated checks.
2. The small Bot radius correction, plus native reproduction of the already-existing
   arrival animation. Keep the existing animation unless evidence shows a defect;
   test repeated arrivals, refresh/backfill, grouped messages and reduced motion.

Done means the notification policy matrix passes under fixtures, all four corners
are uniform, existing affected/full regressions and production build pass, and an
explicitly authorized packaged Mac/Linux OS-delivery check is recorded separately.
If OS permissions or a Linux desktop are unavailable, mark that release gate pending;
do not call fixture success real delivery. Exclude Gmail implementation, sync engine,
What's New visuals, global restyling, new storage schema and wholesale animation
work from this batch.

Next: long-history rendering/benchmark tranche; Google adapter fixtures and owner
app-setup checklist; then staged live qualification. In parallel planning, settle
sync trust/data/conflict decisions and qualify the existing two-host protocol before
building replication. What's New waits on Bryan's design. No calendar delivery dates
are asserted before these dependencies are resolved.
