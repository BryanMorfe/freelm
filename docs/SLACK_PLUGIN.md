# Slack plugin — deferred proposal

Status: documented for later on October 19, 2026. This is a product direction and implementation outline, not an available plugin or implemented SDK contract.

## Intended experience

Slack should be another place to talk with the user's existing FreeLM bots. Nova and Pip retain their own identities, personalities, learned notes, and home hosts. Messages should feel like a conversation with those bots, including when they proactively send reminders or report on delegated work.

The user creates a Slack workspace, installs an independently packaged FreeLM Slack plugin, and connects selected bots. An impersonal shared notification sender does not meet the requirement.

| Capability | Required behavior |
| --- | --- |
| Individual bot identities | Each connected bot has a recognizable name/avatar and a stable Slack identity that can be addressed independently. Direct messages and mentions route to the intended bot. |
| Two-way messaging | Message a bot in Slack, receive its reply, and continue from either Slack or the linked FreeLM conversation. Preserve authorship, thread context, and reply targets. |
| Reminders | Request reminders in either surface and deliver them from the relevant bot to a selected Slack destination through FreeLM's scheduler. Fixed-text reminders do not require inference to deliver. |
| Task updates | Report completion, failure, or a need for user input from delegated Chat/Code work. Replies in Slack can continue that work through existing thread tools, within the user's permissions. |

Use concise conversational messages and notify on meaningful changes rather than every reasoning step or tool call. Users choose which bots, conversations, and update types are connected; historical conversations are not automatically exported.

## Identity is an implementation gate

Slack offers [`chat:write.customize`](https://docs.slack.dev/reference/scopes/chat.write.customize/) to change a message's displayed name and avatar. Display customization alone is not proof of independent DM or mention identities.

Before implementation, validate two real, independently addressable Slack bot identities. The initial candidate is a separate Slack app/bot installation for each connected FreeLM bot, managed by one FreeLM plugin. Confirm provisioning and workspace administration requirements with Slack's current APIs. Do not assume one Slack app can create arbitrary independent bot users, or silently substitute cosmetic names on a shared sender.

Bindings use stable identifiers: FreeLM host ID + bot ID, Slack workspace/app/bot IDs, and conversation/thread IDs. Names and `@freelm` addresses are display information, not routing or authentication keys. Renaming a bot must not break its binding.

## Architecture and missing capabilities

The Slack package owns provider setup, formatting, identity mapping, and event translation. General messaging capabilities belong in the Plugin SDK so other channels can reuse them. Keep Slack-specific implementation outside FreeLM's core.

Existing foundations are [host-owned Bots and thread watches](BOTS.md), [independent plugins and per-bot tool grants](PLUGINS.md), and [durable reminders and scheduled work](SCHEDULER.md).

Required additions, not existing API promises:

- Channel registration, bot/destination bindings, and an inbound event lifecycle that can wake a bot without an open UI tab.
- Outbound bot-reply, fixed-reminder, and task-update hooks with a durable delivery queue. A model-only send tool is insufficient for automatic or model-free delivery.
- Inbound event deduplication, message/thread correlation, retry/reconciliation, and visible delivery failures. Keep task admission, completion, provider acceptance, and delivery evidence distinct; API acceptance is not a read receipt.
- Host-owned credentials appropriate for Slack. Current public-client PKCE OAuth support does not establish compatibility with Slack's installation flow or bot/app tokens. Extend secret handling or use an authenticated relay; credentials never belong in plugin bundles or model context.
- A supported persistent event transport. The current plugin runtime does not expose an always-on socket lifecycle; evaluate host-brokered transport or a separate relay.

For a personal workspace, [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) is a candidate because it receives events over a WebSocket without a public inbound HTTP endpoint. Slack currently excludes Socket Mode apps from its public Slack Marketplace; freelm.ai distribution and Slack marketplace distribution are separate decisions. The [Events API](https://docs.slack.dev/apis/events-api/) also supports a public HTTP receiver if a relay is chosen. Revalidate these constraints when implementation starts.

## Routing, permissions, and availability

- Explicitly bind authorized Slack users to FreeLM access. Workspace membership alone does not grant access to private threads, memories, files, or tools. Shared-channel updates require a selected audience.
- Preserve home-host ownership and current bot/tool grants. Current scheduling rejects remote-origin mutations; define how verified Slack requests acquire scheduling authority rather than disguising them as local UI requests.
- Preserve human approval boundaries. Bot messages, reactions, and transport retries do not grant additional authority or automatically answer Code approval requests.
- Suppress outbound echoes and cross-channel bot loops using stable event identities. Start with DMs and explicit channel mentions; broader group participation can reuse FreeLM's bounded, optional reply behavior later.
- Persist bindings and pending deliveries. Respect rate limits, reconcile uncertain send outcomes, and expose disconnected, reconnect-required, queued, and failed states with retry controls. Recheck grants before dispatch; disabling a binding stops future sends.
- The owning FreeLM host must currently be running and awake. A relay receiving Slack events does not make a sleeping bot able to respond. Define offline buffering and missed-message recovery before release.

## Acceptance criteria

1. Nova and Pip appear as distinct Slack bots. DMs and mentions reach the intended bot after renames and with identically named bots on different hosts.
2. A conversation can continue from Slack or FreeLM with correct author/thread context, without duplicate messages or reply loops.
3. One-time and recurring reminders arrive from the selected bot at the configured destination. Verify storage, dispatch, provider acceptance, and visible Slack receipt separately; fixed reminders still deliver when inference is unavailable.
4. Delegated work produces completion, failure, or input-needed updates in the originating conversation. A permitted follow-up reaches the correct Chat/Code thread; admission is not reported as completion.
5. Duplicate events, restart recovery, uncertain sends, rate limits, revoked credentials, disabled bots, and offline hosts have recoverable states without repeating work or misrouting private content.
6. Unbound Slack users cannot access private FreeLM context or execute bot tools. Credentials stay out of prompts, transcripts, and diagnostics.

## When this work resumes

First prove the two-bot identity/provisioning experience, then settle authentication and transport, design the generic SDK contracts, and build an end-to-end plugin trial. Decide separately whether edits, deletions, reactions, attachments, and group interactions belong in the first release. Public marketplace distribution, broad workspace search, and historical synchronization are outside this initial proposal.

Documentation only: creating Slack apps, connecting accounts, installing the plugin, or sending test messages is deferred until implementation is requested.
