# FreeLM backlog

Priorities recorded 2026-10-21. Completion requires evidence for the specific
provider/model and app surface; synthetic fixtures do not certify live service use.

## P1 — Anthropic support

Requested by the owner. Track two distinct workstreams:

- [ ] Qualify Claude through the existing OpenAI-compatible Chat Completions path:
      base URL/auth, explicit Standard mode, text/image input, streaming, modern tools,
      cancellation, errors, and multi-turn Chat, Code and Bots. Start with contract
      fixtures; live verification needs separate authorization and a bounded cost.
- [ ] Surface compatibility limits: the Claude layer ignores reasoning effort,
      `response_format` and tool `strict`; do not promise those controls or guarantees.
- [ ] Separately design native Claude support for Messages, thinking, caching and
      structured output capabilities. This is architecture work, not part of the current
      generic-provider fix tranche.

Reference: [Anthropic's OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk).

## P1 — OpenAI-compatible provider qualification

- [ ] Validate model/endpoint-specific tools and structured output capabilities
      before starting Code/Bot work. Text support alone does not establish tool support.
- [ ] Add an opt-in live-provider qualification suite with owner-approved prompts,
      credential handling, provider/model versions and spending limits.
- [ ] Keep the [capability matrix](PROVIDER_COMPATIBILITY.md) current as evidence is added.

## Deferred — Native fal.ai integration

The owner explicitly deferred nonstandard fal APIs. Native fal model/queue
adapters remain unsupported. Do not label a changed base URL as native fal support.

## Release readiness

- [ ] Owner chooses a root project license; do not infer one from third-party notices.
- [ ] Complete physical Linux desktop and cross-machine SSH validation. Linux build
      and packaging success alone do not establish graphical or network behavior.
- [ ] Review initial renderer bundle size and loading performance on ordinary hardware.

## P2 — Setup and everyday navigation

- [x] Connect-an-API entry opens Connections in both Chat and Code; link connection
      details to model configuration, and put discovery/models before reusable presets.
- [x] Empty model picker offers configuration, with Standard mode in setup guidance.
- [x] Verify discovery loading/cancel/error/retry, draft keep/discard, bot dialog
      cancel/reopen, Chat/Code/Bots navigation and native relaunch with disposable data.
- [ ] Give unconfigured Bots a direct route to model setup on the owning host while
      retaining the bot draft. The current dialog explains the requirement but has no
      setup shortcut; creation without a model remains intentional.
- [ ] Measure first-run loading and rendering on ordinary hardware. Browser dev-mode
      checks on this Mac exceeded five-second assertions; production Electron passes.
- [ ] Complete a broader keyboard/screen-reader audit beyond the verified setup
      buttons, settings controls, navigation menus and dialog dismissal.

Validation boundary: the setup smoke uses a loopback discovery fixture and makes
no inference requests. Paid live-provider, physical Linux UI, cross-machine SSH,
Anthropic qualification and owner license selection above remain open.

## Production-readiness roadmap — 2026-10-23

See [the seven-area audit and roadmap](PRODUCTION_READINESS.md) for current evidence,
priorities, dependencies, acceptance criteria and the proposed bounded first batch.
It covers Gmail/Calendar, OS completion notifications, Bryan-designed What's New,
Bot message behavior, shared motion, bounded history rendering and accountless peer
synchronization, plus font portability and semantic colors. This is planning only;
implementation and live qualification have not begun. Existing backlog items above
remain open unless explicitly marked complete.

### Completion feedback implementation (2026-10-23)

- Shared completion routing/deduplication, Bot chime preferences and uniform Bot bubbles are
  implemented for the bounded first readiness batch; see [behavior and limits](COMPLETION_FEEDBACK.md).
- Release gates remain: real OS delivery on permitted disposable Mac/Linux profiles, actual
  Computer Use when the executor exposes it, and cross-device notification policy/verification.
  Keep Gmail/Calendar setup, peer replication, Bryan's What's New design, bounded history,
  bundled-font portability, semantic colors, Anthropic coverage and owner-selected root license
  in the production-readiness roadmap. This batch does not implement those separate areas.
