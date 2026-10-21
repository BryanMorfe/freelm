# Code composer audit and implementation plan

Audited October 6, 2026 against FreeLM source and Codex CLI rust-v0.158.0, pinned to [064c6b8c737f5b41d171fdda80bd9ef10ad06eb3](https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3). This began as an inventory and implementation plan. The October 7 composer update implements the first interaction group below; the remaining roadmap still describes work to do.

This complements [the model-callable tool inventory](codex-tool-inventory.md) and [FreeLM runtime capabilities](tools.md). Composer commands are actions initiated by the human. They are distinct from tools exposed to a model.

The pinned CLI is the implementation reference. The current official [desktop slash-command reference](https://learn.chatgpt.com/docs/reference/slash-commands) and [developer command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) supply additional product context; documentation for other surfaces or releases does not establish that behavior in the pinned CLI.

## Current baseline

FreeLM already has:

- A shared CodeMirror Markdown composer with direct code/math editing, syntax highlighting, undo/redo, multiline input, and IME guards.
- Image/text uploads, clipboard file paste, drag/drop, rich-text paste conversion, and large pastes converted to text attachments.
- Persistent per-conversation drafts, failed-send draft recovery, reply-to-selected-text context, and restoration of the most recent sent prompt.
- Editable Code input during streaming, model/permission controls, and persistent queued messages with editing/removal/retry.
- Goal controls above Code input; goal, memory, history, notes, context, planning-checklist and task tools in the runtime.
- Model/thinking, project, permission, personalization, skills and MCP settings.

Those features need integration and preservation rather than replacement. The October 7 update connects Code’s composer to Goals, Plan mode, configured skills, and workspace file/folder references. `/goal` and `/plan` select removable toolbar modes before submission. Mid-message `/skill-name` selects an inline skill reference. `@` opens the available context actions, including files/folders, skills, goal, plan, and file uploads. Arrow keys, Enter/Tab and Escape navigate the picker; IME input, fenced code and equations remain literal. Selections survive drafts, queue edits, history recovery and prompt restoration.

Only Code offers local references. Discovery runs on the selected execution host, returns bounded metadata, and never starts MCP servers or commands. Submitted references are revalidated against the active task and configured skill roots. Selected files contribute their identity/path; the agent uses its read tools for contents. Selected skills load the exact bounded SKILL.md as instructions subordinate to the user. Plan mode is enforced by the execution host, including orchestration; a completed proposed plan offers **Implement plan**. Old hosts that cannot enforce Plan mode or resolve references return a clear update error.

Source: [MarkdownComposer](../src/components/MarkdownComposer.tsx), [Chat composer and queue integration](../src/components/Chat.tsx), [draft/message types](../src/types.ts), [Code goals](../src/components/CodeGoalControls.tsx), [App run dispatch](../src/App.tsx).

## Composer roadmap

| Area                         | Missing or partial behavior                                                                                                                                                       | Runtime dependency                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Command discovery            | Implemented for Goal, Plan and configured skills; broader session commands and argument forms remain.                                                                             | Shared command registry and human-action dispatcher.                                                                         |
| Goal commands                | Goal mode sets a persistent objective from the submitted prompt. Existing goal controls handle status/pause/resume/clear; broader slash management and objective editing remain.  | Reuse persistent goals; add objective editing without losing usage.                                                          |
| Planning mode                | Implemented: persistent composer selection, read-only host admission, proposed-plan rendering and explicit implementation action.                                                 | New collaboration mode; existing update_plan is only a progress checklist.                                                   |
| Skills                       | Implemented: searchable inline references and host-side exact skill resolution.                                                                                                   | Existing skill runtime needs stable IDs in composer metadata and explicit input resolution.                                  |
| Workspace files/folders      | Implemented: bounded host-side path/name discovery and inline file/folder identity.                                                                                               | New asynchronous host-side metadata search, including remote hosts and multiple roots.                                       |
| Task references              | Mention another task and retain its identity through edits/restores.                                                                                                              | Existing task read tools plus picker/reference serialization.                                                                |
| Integrations                 | Browse/reference configured MCP capabilities/resources. Actual apps/plugins have richer identity and lifecycle semantics.                                                         | MCP exists; native app/plugin registries are separate missing capabilities.                                                  |
| Session controls             | Slash access to model/thinking, permissions, project, personality, status, new/resume/rename/fork/archive, copy/export and settings.                                              | Mostly existing UI/state actions; status/export need a focused presentation.                                                 |
| Context controls             | Visible context usage, manual compaction, deliberate context reset, and a conversation recap.                                                                                     | Automatic compaction and model context tools exist; human command dispatch/status do not.                                    |
| Development workflows        | Review changes, inspect Git diffs, initialize repository instructions, inspect/stop background terminals, and retry a specific denied action.                                     | Dedicated host/session UI and authorization paths; AGENTS.md loading must accompany initialization.                          |
| Prompt history               | Traverse multiple sent prompts, search earlier prompts, accept a preview, and restore the draft on cancel.                                                                        | Current Up shortcut only restores the latest user message.                                                                   |
| Editing shortcuts            | Discoverable shortcuts, queue-edit shortcuts, mode/effort shortcuts, external-editor round trips, configurable keymaps and optional Vim behavior.                                 | Existing CodeMirror editing is preserved; platform shortcuts must be adapted.                                                |
| Direct shell input           | An explicit shell-input mode for user-entered commands.                                                                                                                           | Reuse command execution and permissions; visibly distinguish shell input from an AI request.                                 |
| Code dictation               | Reuse configured ASR in Code.                                                                                                                                                     | Existing DictationButton is currently rendered only in Chat; realtime voice is a separate deferred feature.                  |
| Completion resilience        | Cursor-aware token replacement, identities/atomic spans, duplicate-name disambiguation, preserved references on paste/undo/edit/reload/queue/fork, and stale-result cancellation. | Shared structured draft/submission model across renderer, persistence, IPC and remote transport.                             |
| Recovery and context capture | Recover interrupted question drafts; optionally attach an IDE selection/open-file range with provenance.                                                                          | Question draft handling and IDE integration need additional work.                                                            |
| Full draft snapshots         | Restore caret/selection and task-local editing state, rather than always resetting the caret to the end.                                                                          | Current persistent drafts retain content/assets/reply but not editor state. Keep undo isolated between conversations.        |
| Embedded editors             | Share Markdown/math/paste behavior with sent-message editing and question answers.                                                                                                | Those inputs currently use plain textareas; integrate without losing non-blocking sheets.                                    |
| Attachment power controls    | Keyboard selection/removal, pasted image-path recognition, stable attachment references and optional inline large-paste placeholders.                                             | Actual file paste/drop already works. PDFs/binary documents and audio/video require explicit adapters, not the text decoder. |
| Startup/reconnect state      | Keep draft editing safe through initialization/reconnection, defer an accepted submission once, and show why sending is unavailable.                                              | Storage-transition protections exist; a shared capability/state contract and recovery handoff are partial.                   |

## Syntax and behavior to adopt

The CLI invokes a skill with **$skill-name**; **/skills** opens its picker. Current desktop documentation also lists enabled skills in the slash menu. FreeLM will support the requested **/skill-name** alias as well as **$skill-name**. Built-in commands take precedence; duplicate skill names require selecting an exact discovered identity.

**@query** searches context. Start with Files and Skills; add Tasks and MCP as their adapters land. A file/folder selection is a path reference, not an eager upload of all its content. Selected local images use the existing bounded image attachment path. Task references retain the task ID and require a fresh task read before the model relies on that task.

Completion operates at the cursor outside code/math. It must not hijack shell variables, email addresses, ordinary filesystem paths, code fences, or equations. Recognized control commands run locally; they are not sent to the model as chat text. A recognized but unavailable command explains why and preserves the draft. Unknown slash-prefixed text offers correction and an explicit send-as-text route. Absolute paths and escaped/literal forms remain ordinary text.

### Core command contracts

| Input                                                    | Planned FreeLM behavior                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /goal                                                    | Open the current goal controls or goal editor without a model request.                                                                                           |
| /goal objective                                          | Save the objective and start/steer the associated work through the normal task dispatcher.                                                                       |
| /goal edit, pause, resume, clear                         | Operate on the goal directly. Editing preserves counters; controls remain available while working. Budget stays an explicit editor field.                        |
| /plan                                                    | Enter planning mode while idle; show the selected mode beside the composer.                                                                                      |
| /plan prompt                                             | Enter planning mode and submit the prompt with its attachments and references.                                                                                   |
| /skills, /skill-name, $skill-name                        | Open the picker or insert a selected skill reference for the next request.                                                                                       |
| /mention, @path                                          | Open/search the context picker and insert a workspace reference.                                                                                                 |
| /model, /reasoning, /permissions, /project, /personality | Reuse the respective picker/settings action. Project changes retain the existing task-binding restrictions.                                                      |
| /status                                                  | Show host, project roots, model/effort, permissions, workflow mode, goal and measured/estimated context usage; redact credentials.                               |
| /new, /task, /resume, /rename, /fork, /archive           | Reuse durable task navigation/actions. Forks end at a completed assistant reply. No command destroys history implicitly.                                         |
| /copy, /export                                           | Copy the latest completed reply; export the active conversation to Markdown, with an explicit choice to include activity.                                        |
| /compact                                                 | Compact an idle task through the existing summary pipeline, preserving original recovery history.                                                                |
| /recap                                                   | Request a visible conversation summary without changing the context checkpoint.                                                                                  |
| /context, /new-context                                   | FreeLM-specific aliases for context inspection/reset. Reset uses the existing completed-exchange boundary and preserves original history.                        |
| /review, /diff, /init                                    | Dedicated review/diff/instruction workflows on the selected host/project; no silent AGENTS.md overwrite.                                                         |
| /ps, /stop, /approve                                     | Inspect task-owned terminal sessions, stop selected/all task terminals, or explicitly approve one exact denied action. These do not grant blanket future access. |

The goal and plan contracts above adapt the CLI workflow to FreeLM's existing safe-boundary message delivery. They are proposed behavior, not claims that these composer commands already work.

## Complete pinned CLI command inventory

The source enum has **62 variants**, including aliases and internal/debug entries. Availability varies with feature flags, platform, thread ownership and active side conversations. Model-defined service-tier commands are additional dynamic entries. Do not show every command simply because it appears in this inventory.

All slash routes are currently missing in FreeLM. “Existing” below refers to an equivalent feature accessible elsewhere, not an implemented slash command.

| Group                   | Pinned command names                                                                           | FreeLM disposition                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model and authorization | /model, /permissions, /approve                                                                 | Model/permission pickers exist. Exact-action approval retry needs a host workflow.                                                                                                                                                                                                                             |
| Goals and plans         | /goal, /plan                                                                                   | Goals exist. Planning collaboration mode is missing.                                                                                                                                                                                                                                                           |
| Knowledge and context   | /memories, /skills, /mention, /compact, /recap                                                 | Knowledge/skill tools and automatic compaction exist. Missing human pickers, management controls, manual compaction and recap.                                                                                                                                                                                 |
| Task lifecycle          | /new, /clear, /rename, /resume, /fork, /archive, /delete                                       | Existing task actions can be reused. Map clear to a new task, never deletion; permanent delete retains explicit confirmation.                                                                                                                                                                                  |
| Side tasks and agents   | /agents, /subagents, /side, /btw                                                               | Task listing/background execution exists. No ephemeral side-chat UI or subagent runtime. Agents should list Code tasks without implying subagents exist.                                                                                                                                                       |
| Development             | /review, /diff, /init, /worktree, /cd, /pwd                                                    | Command execution and file changes exist. Need review/diff/instruction UX and task-specific directory handling. Git worktree lifecycle is missing.                                                                                                                                                             |
| Terminals and outputs   | /ps, /stop, /copy, /export                                                                     | Execution sessions/copy exist. Need terminal enumeration/control and conversation export surfaces.                                                                                                                                                                                                             |
| Integrations            | /mcp, /apps, /plugins, /hooks, /ide, /import                                                   | MCP/skills exist. Apps/plugins/hooks/IDE capture and importing another agent's setup/projects/chats require separate registries or adapters. Do not label any MCP server an installed app/plugin.                                                                                                              |
| Voice                   | /voice                                                                                         | Chat dictation exists; Code dictation and realtime voice are distinct gaps. Realtime voice remains deferred by prior product scope.                                                                                                                                                                            |
| Diagnostics             | /status, /warnings, /debug-config, /rollout                                                    | Add redacted task status/diagnostics and retained warnings. A Codex rollout path is not a FreeLM path contract. Debug-only data stays behind Debug.                                                                                                                                                            |
| Editor preferences      | /keymap, /vim, /theme                                                                          | Add desktop shortcut preferences/optional Vim later. Appearance exists; syntax theme controls are separate.                                                                                                                                                                                                    |
| Terminal presentation   | /raw, /tui, /title, /statusline, /pets                                                         | Terminal-specific presentation is not desktop parity work. A context/status footer is useful; pets are optional product scope.                                                                                                                                                                                 |
| Platform/service        | /setup-default-sandbox, /experimental, /daemon, /usage, /logout, /app, /quit, /exit, /feedback | Windows sandbox/TUI handoff do not apply to macOS/Linux desktop. Remote instance controls are the relevant server UI. Backend usage/auth/service tiers require advertised provider support; no fabricated account limits/resets. Feedback does not transmit logs automatically. Quit uses normal app shutdown. |
| Internal tests          | /test-approval, /debug-m-drop, /debug-m-update                                                 | Do not expose in the normal composer.                                                                                                                                                                                                                                                                          |

Recognized source aliases include **/cwd** for /pwd, **/clean** for /stop, **/pet** for /pets, and /btw for /side. /quit and /exit share an action. The CLI also accepts elongated goal spellings; this is not needed for FreeLM. Dynamic tier commands such as /fast appear only when supported by the model catalog; they are not universal API parameters.

Desktop commands such as **/reasoning, /project, /task, /personality, /ide-context, /local, /cloud, /cloud-environment** are product-surface additions rather than all being pinned enum entries. The first four can reuse FreeLM controls. Local/remote host selection must use FreeLM's actual connection model; no cloud environment service is assumed.

Custom prompt templates under **/prompts:name** are documented for desktop, but were not found in the pinned CLI registry/composer. Treat a reusable prompt-template store as a separate later feature rather than claiming it is already supplied by the CLI source.

Pinned CLI argument parsing is explicit per command: /model and /permissions are picker-only, /pwd rejects arguments, and /goal treats all non-control text as the objective rather than parsing token-budget flags. FreeLM adaptations must document any additional accepted syntax.

While working, the CLI allows goal/model/permission controls, but blocks task replacement/archive, context replacement and planning/review entry. /resume has an additional dispatch-time busy restriction despite its enum flag. FreeLM must validate availability both when selected and at delivery; queued commands are reparsed against current state. No busy-state rejection may silently consume a draft.

## Implementation sequence

### 1. Shared composer foundation

Build one command registry, completion state machine, suggestion list, and typed input model around the existing MarkdownComposer. Keep command definitions, availability, arguments, labels and execution in one place; toolbar actions and slash actions call the same dispatcher.

Add stable context references and editor ranges to drafts, queued input and stored messages. Update validators, IPC/remote contracts, exports, copies, edits, failed sends, prompt restore and conversation forks together. Commands are human actions, never model tool calls.

Add a read-only composer metadata/search bridge separate from run execution. It identifies capabilities on the chosen host and supplies skill metadata and scoped filename results before the user sends a message. Metadata reads do not start a model request or command.

Deliver the command menu and /goal, /model, /reasoning, /permissions, /project, /personality, /status plus basic new/rename/resume/copy actions. Preserve the whole draft on rejection or canceled UI. Goal objective editing reuses the same controls.

### 2. Skills and workspace references

Deliver /skills, /skill-name, $skill-name, @file/@folder and /mention using the shared suggestion component. Include source/root information for ambiguous names and distinguish same-named files in different roots.

Resolve skill identity on the host at submission, load the selected entry instructions with existing bounded skill reads, and keep resource access within its skill root. File references retain the selected canonical scope/path; content reads still go through the actual host tools and approvals. A path mention does not change execution permissions.

Persist references in the next draft/queued message and revalidate them on send. Removed files/skills, switched hosts and changed project scope produce an actionable error, without dropping the draft. No local filesystem fallback for remote tasks.

### 3. Real planning mode and context workflow

Add a persisted Code collaboration mode, separate from Chat/Code navigation and permission policy. Ship /plan only once its prompt, questions, host behavior and plan rendering are implemented.

Follow the CLI's explore/clarify/finalize workflow. Render a proposed plan as a readable plan with “Implement” and “Keep planning” actions. Implement changes mode only after user action; an instruction to implement while still in Plan mode remains a planning request.

Also offer “Start fresh and implement”: create a new task with the approved plan and a link to its originating task, preserving the original planning transcript. Changing context or creating that task is explicit; merely viewing the plan does neither. Support ordinary final-plan text from arbitrary providers as well as the CLI's proposed-plan marker.

Enforce the workflow on every tool path, including nested orchestration and MCP: block plan-executing mutations; allow supported plan-improving inspection/checks. Unknown shell/MCP effects require a clear policy decision rather than an assumed read-only classification. Existing process permissions are not an OS sandbox; do not imply otherwise. Suppress goal auto-continuation during planning until the user chooses implementation.

Add a lightweight context indicator, /compact, /recap and explicit context reset using the existing recovery-preserving pipeline. No new fixed turn limit.

**First usable composer milestone is phases 1–3:** slash discovery, goals, skills, workspace files and meaningful planning mode together.

### 4. Session, development and richer context actions

Complete /fork, /archive, /export, /review, /diff, /init, /ps, /stop and /approve. Add task references, then configured MCP resource/capability references. Support task-specific directory changes without silently changing the project or expanding its configured roots.

Pair /init with proper hierarchical AGENTS.md discovery/loading; generating a file without consuming it is incomplete. Reuse the permission reviewer for exact-action retry and code workflows, never use slash input as a reason to bypass host validation.

Side conversations, worktrees, app/plugin registries, lifecycle hooks, IDE capture and providers' service-tier/account APIs remain named follow-on dependencies. Each command appears only when its real adapter is available.

### 5. Prompt history and power editing

Add multiple-prompt history and cancellable search with preview/accept/cancel, using a bounded store under FREELM_HOME. Preserve the unsent draft when traversing history. Scope history to the selected host/workspace; exclude temporary conversations and expose a clear-history control. Session-only attachments/references must not be silently reconstructed from unrelated historical paths.

Add shortcut help/remapping, effort/mode and queue-edit actions, external-editor round trips, Code dictation through the configured ASR, and optional Vim/shell-input mode. Keep existing Enter/Shift-Enter, code indentation, math editing and IME behavior.

Follow with shared rich editors for message edits/questions, durable interrupted answer drafts, task-local caret/selection snapshots, keyboard attachment handling and optional inline paste elements. Preserve CodeMirror's ordinary movement/deletion/undo; a persistent kill/yank buffer is optional power editing. Startup/reconnect submission must be owned exactly once and cannot overwrite a newer draft.

Preserve FreeLM's current default: Code messages join after the next safe tool/model boundary. Codex distinguishes Enter steering from Tab queueing; importing its idle-only queue semantics would regress the user's requested behavior. Any future “after this turn” delivery option must be a separately labeled intent.

## Performance and acceptance checks

- No recursive scans or skill-file reads in the renderer. Host workers/indexes reuse searches, respect ignore rules, bound result/scan budgets, debounce requests and cancel stale generations. Initial target: 20 visible filename suggestions; expose a result cap rather than pretending a bounded search is exhaustive.
- Cache metadata by host, project roots, configured skill directories and generation. Refresh on scope/configuration changes; avoid startup of MCP servers on each keystroke.
- Retain FreeLM's existing symlink/path validation rather than blindly copying the CLI walker, which can follow symlinks.
- Suggestion menus keep editor focus, keyboard navigation, accessible active-option labels and correct caret placement. Escape first dismisses suggestions/search; it must not unexpectedly stop a run.
- Use at least 13px for option labels/buttons/headers. Menus anchor above the composer, remain usable in narrow windows, and do not move or resize the conversation on each keystroke.
- Test parser/completion around Unicode, quotes/spaces, cursor edits, literal paths, $HOME, emails, equations, fenced code, duplicate skills, stale callbacks and simultaneous tasks.
- Test structured references through draft reload, queue edit/retry, message editing, versions, fork, archive/restore, task export and old-profile migrations.
- Test local/remote scope with two roots, same filenames, disabled/missing skills, deleted files, disconnected/stale hosts and unauthorized paths.
- Test goal commands while streaming, pause/resume/edit/clear persistence, Plan-mode lifecycle and mutations attempted through direct and nested tools, and continued question-sheet usability.
- Test command availability at dispatch and after queued delivery, rejected/unknown command draft retention, and unsupported remote capability notices. Goal controls may run while working; Plan-mode entry and context replacement wait for a valid idle/boundary state.
- Test manual compaction/reset preserves original history and does not duplicate provider tool exchanges. Usage displays measured versus estimated values clearly.
- Browser tests use deterministic test providers; native package tests verify the actual build/menu, attachment handling, keyboard behavior and profile preservation. Linux and macOS native checks are separate evidence.

## Source map

All upstream paths below refer to the pinned commit:

- [Slash registry, argument support and busy rules](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/slash_command.rs)
- [Feature/capability filtering](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/bottom_pane/slash_commands.rs)
- [Command menu](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/bottom_pane/command_popup.rs)
- [Slash parsing and dispatch](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/chatwidget/slash_dispatch.rs)
- [Composer state machine, mentions, attachments and history](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/bottom_pane/chat_composer.rs)
- [Unified reference catalog](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/bottom_pane/mentions_v2/search_catalog.rs)
- [Structured user input](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/protocol/src/user_input.rs)
- [Input identity validation and submission](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/chatwidget/input_submission.rs)
- [Reusable asynchronous file search](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/file_search.rs)
- [Filename search implementation](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/file-search/src/lib.rs)
- [Task mentions](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/task_mentions.rs)
- [Keyboard defaults and customization](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/keymap.rs)
- [Plan-mode prompt contract](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/collaboration-mode-templates/templates/plan.md)
- [Proposed-plan completion UX tests](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/chatwidget/tests/plan_mode.rs)

Verification for this audit is source inspection and official documentation review. No new inference requests, app runtime changes or profile changes were made.
