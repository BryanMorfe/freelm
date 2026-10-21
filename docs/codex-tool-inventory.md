# Codex CLI tool inventory for FreeLM

Inspected September 28, 2026. This is a source inventory and a record of FreeLM's current gaps; it does not enable or implement tools.

The FreeLM gap assessment below records the pre-implementation snapshot. See [Tools in FreeLM](tools.md) for the subsequently implemented capabilities and their current boundaries.

## Reference and scope

The installed CLI reports `codex-cli 0.149.1`. This inventory uses the newer stable upstream release [`rust-v0.158.0`](https://github.com/openai/codex/releases/tag/rust-v0.158.0), published September 28, 2026, pinned to commit [`064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`](https://github.com/openai/codex/commit/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3). The installed CLI was not updated. Source was inspected without running an agent or contacting an inference model.

“Available” below means implemented and reachable through a production registration path in that release, including optional extensions. It does **not** mean every tool is exposed in every session. Model metadata, provider capabilities, feature flags, authentication, execution environments, permissions, and the hosting client all affect the actual catalog. A policy requiring a managed sandbox suppresses core tools if the thread or any selected environment does not have a managed permission profile. The [central registry][registry] and [app-server extension installer][extensions] are the starting points for these conditions.

Names are source-level tool names, qualified by namespace where applicable. They may be flattened for a provider, deferred until discovery, or exposed through the JavaScript code-mode bridge. The tables summarize important arguments and results; linked schemas are the authority for exact validation. Arbitrary configured MCP servers and client-supplied dynamic tools make the full runtime catalog open-ended.

## Core execution and interaction tools

The following are the 15 core names in this group, including one internal test helper. Plain names generally appear in the `functions` namespace; the two clock tools use `clock`. An execution environment can be local or remote. All registrations also pass through tool-policy filtering. [Core registration][registry]; [handler sources][handlers]

| Tool                         | Important input and result                                                                                                                                                               | Availability / implementation notes                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec_command`               | `cmd`; optional `workdir`, `shell`, `login`, `tty`, `yield_time_ms`, `max_output_tokens`, environment and permission fields. Returns output, timing, exit status or a live `session_id`. | Needs an environment, `shell_tool`, and a model permitting shell execution. `unified_exec` enables resumable sessions.                                                                          |
| `write_stdin`                | `session_id`; optional `chars`, `yield_time_ms`, `max_output_tokens`. Returns new output and process status.                                                                             | Only with unified execution. Empty input polls; nonempty input writes to the process.                                                                                                           |
| `apply_patch`                | Freeform `*** Begin Patch` … `*** End Patch` text; add/update/delete/move file operations. Returns changed-file status.                                                                  | Needs an environment and model patch-tool support. Multiple environments can be selected with an optional `*** Environment ID: …` header. This is not a JSON tool.                              |
| `view_image`                 | `path`; optional `environment_id` and conditional `detail: high/original`. Returns image content; code mode receives an image data URL.                                                  | `view_image`, an environment, and a model accepting image inputs.                                                                                                                               |
| `update_plan`                | `plan: [{step, status}]`, where status is `pending`, `in_progress`, or `completed`; optional `explanation`.                                                                              | `tools.update_plan.enabled`, default false. This checklist tool is rejected in Plan mode. At most one step should be in progress.                                                               |
| `request_user_input`         | `questions: [{id, header, question, options: [{label, description}]}]`. Waits and returns answers by question ID.                                                                        | Root agent, enabled configuration, and an allowed mode. Normally Plan mode; Default mode requires its feature. Direct model calls only.                                                         |
| `request_user_input_async`   | `questions: [{title, options?: string[]}]`. Returns accepted immediately; answers arrive later.                                                                                          | Root agent and model capability metadata; direct model calls only. Model-specific schema overrides are possible. `send_user_message_async` is a legacy capability marker, not the exposed name. |
| `send_message_to_user_async` | `message`. Returns accepted immediately.                                                                                                                                                 | Root agent and feature/model support; direct model calls only. Sends a message in the current user interaction; it is not email or external messaging.                                          |
| `request_permissions`        | `permissions` with network and filesystem read/write requests; optional `reason`, `environment_id`. Returns granted permissions and turn/session scope.                                  | Environment plus `request_permissions_tool`; invokes the host permission workflow. The returned permission representation need not exactly echo the request.                                    |
| `wait_for_environment`       | `environment_id`. Returns ready status or an error.                                                                                                                                      | `deferred_executor`; waits for an environment already starting. It does not provision a machine itself.                                                                                         |
| `get_context_remaining`      | Empty object. Returns remaining context tokens, or unknown.                                                                                                                              | `token_budget`. Requires real token/context accounting.                                                                                                                                         |
| `new_context`                | Empty object. Requests a fresh context window without summarizing history.                                                                                                               | `token_budget`; direct model calls only. Execution environment state survives. The exported tool is `new_context`, despite the handler filename `new_context_window`.                           |
| `clock.curr_time`            | Empty object. Returns current UTC time.                                                                                                                                                  | Current-time feature or model `clock` capability.                                                                                                                                               |
| `clock.sleep`                | `duration_ms`, from 1 to 43,200,000. Returns elapsed time/interruption.                                                                                                                  | `sleep_tool` and sleep-mode policy. New user input interrupts the wait. Direct model calls only.                                                                                                |
| `test_sync_tool`             | Optional sleeps, Git-enrichment wait, and a named multi-participant barrier. Returns success or timeout/error.                                                                           | Only if model metadata explicitly advertises it. Production-registered but intended for internal integration-test synchronization; not an end-user parity requirement.                          |

The [shell schemas][shell-spec] include `sandbox_permissions`, `justification`, and `prefix_rule`; an additional-permissions feature/policy can expose network and filesystem permission profiles. Some fields are conditional: `tty` needs its feature, `login` requires allowed login shells, and `environment_id` is exposed for multiple environments. Permission enforcement is a host responsibility, not an instruction that can be delegated to the model.

With unified execution disabled, the name remains `exec_command`, but it becomes one-shot: `timeout_ms` replaces the yielding interaction, `tty` is unavailable, and there is no live `session_id` or `write_stdin`. Unified execution normally yields after 10 seconds and may continue in the background. Process sessions, output limits, cancellation, and cleanup are part of parity, not just running a shell string. [One-shot schema adaptation][one-shot]

### Code-mode orchestration

Code mode adds two model-visible tools around other capabilities. It can be selected by model metadata or feature/configuration; runtime availability may cause fallback to direct tools. This is distinct from executing JavaScript in the user's project. [Code-mode registration][code-mode]; [runtime contract][code-mode-contract]

| Tool   | Input                                                                                                       | Behavior                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `exec` | Freeform JavaScript, optionally starting with `// @exec: {"yield_time_ms":10000,"max_output_tokens":10000}` | Execute an async module in a fresh V8 isolate. Call enabled tools through `tools.*`; return emitted content or a running cell ID. |
| `wait` | `cell_id`; optional `yield_time_ms`, `max_tokens`, `terminate`                                              | Resume a yielded cell, returning only new output, or terminate it.                                                                |

The isolate has no Node.js, filesystem, network, or console access. It provides `text`, `image`, `audio`, `generatedImage`, `store/load`, `notify`, `exit`, timers, `ALL_TOOLS`, and `yield_control`. These are runtime helpers, not additional tools. Serializable `store/load` values survive across cells; JavaScript bindings do not, and unawaited promises are discarded when a cell finishes. Some tools are deliberately restricted to direct model calls.

## Subagent coordination

Both generations of the agent API exist in the source, but a session selects an applicable version. V1's feature is default-on; V2's is default-off, with model metadata and explicit configuration also affecting selection. These tools require a child-agent runtime with independent turns, concurrency limits, cancellation, and message delivery. They are not merely additional chats in the sidebar. [Version selection][agent-selection]; [schemas and results][agent-spec]; [registration][agent-registration]

| Tool                            | Important input                                                                                     | Result / behavior                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `multi_agent_v1.spawn_agent`    | `message` or structured `items`; optional `agent_type`, `model`, `reasoning_effort`, `fork_context` | Start a child; return `agent_id` and nickname. Context forking defaults false.                                               |
| `multi_agent_v1.send_input`     | `target`, message/items; optional `interrupt`                                                       | Queue input or interrupt work; return a submission ID.                                                                       |
| `multi_agent_v1.wait_agent`     | `targets`; optional `timeout_ms`                                                                    | Wait for a target's final status; return status map and timeout flag.                                                        |
| `multi_agent_v1.resume_agent`   | `id`                                                                                                | Reopen a closed child; return its status.                                                                                    |
| `multi_agent_v1.close_agent`    | `target`                                                                                            | Close the child and open descendants; return previous status. Completed V1 children still occupy slots until closed.         |
| `collaboration.spawn_agent`     | `task_name`, `message`; optional `fork_turns`, agent type/model/effort where exposed                | Start a V2 child with a hierarchical task path. Forking defaults to `all`; `none` or a positive turn count are alternatives. |
| `collaboration.send_message`    | `target`, `message`                                                                                 | Deliver a message without starting an idle recipient.                                                                        |
| `collaboration.followup_task`   | `target`, `message`                                                                                 | Start a turn on an idle non-root agent or deliver input to a running agent.                                                  |
| `collaboration.wait_agent`      | Optional `timeout_ms`                                                                               | Wait for mailbox activity/interruption; returns a summary, not the agent's full result.                                      |
| `collaboration.interrupt_agent` | `target`                                                                                            | Interrupt and return previous status; keep the agent available.                                                              |
| `collaboration.list_agents`     | Optional `path_prefix`                                                                              | List agents and statuses in the current root tree.                                                                           |

`collaboration` is V2's default namespace, not a fixed requirement: it is configurable and can become unnamespaced when the provider lacks namespace support. Direct messaging and waiting have separate gates. Child depth/model support controls availability; model metadata can override V2 descriptions and schemas. V1 tools can be deferred for tool search. The separate message-board tools are listed below.

## Web, images, discovery, and external integrations

### Search and image generation

| Tool                 | Contract                                                                                                                                                                                                                                                      | Backend and availability                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`         | A hosted Responses API tool declaration, not a locally executed function. Optional domain/location/context settings; configured cached/indexed/live modes.                                                                                                    | Runs at the model provider. Requires provider web capability and an enabled web mode; omitted when the standalone search executor is selected. [Hosted spec][hosted-web]                                                                                                                                                     |
| `web.run`            | Accepts `search_query`, `image_query`, `open`, `click`, `find`, PDF `screenshot`, `finance`, `weather`, `sports`, `time`, and `response_length`. Returns search text to the model; structured result metadata travels separately through extension/UI events. | OSS extension calls authenticated provider-relative `POST alpha/search`. Requires namespace/web capability, enabled mode, Responses-lite model or standalone-search feature, and suitable provider/auth support. It is not a local browser. [Input schema][web-schema]; [execution][web-runtime]; [extension gate][web-gate] |
| `image_gen.imagegen` | `prompt`; optional `transparent_background`, and either `referenced_image_paths` or `num_last_images_to_include` (up to five). Returns an inline PNG and optional artifact hint.                                                                              | OSS extension uses fixed `gpt-image-2` with automatic size/quality; it does not expose arbitrary model/size/quality selectors. Requires image-generation feature/provider capability, namespaces, image input support, and eligible authentication/account. [Implementation][image-tool]; [availability][image-gate]         |

The `standalone_web_search` feature is under development and default-off; Responses-lite model metadata can activate the standalone executor independently. The existing image-generation extension is not a drop-in generic `/images` adapter: it has Codex-auth/provider gates and no public model selector. FreeLM can preserve the user-facing capability while using its configured image providers. The inspected registry has no analogous built-in video, speech, or transcription tools; those could be FreeLM additions backed by its playground adapters.

### Tool discovery and MCP

| Tool / family                 | Important input and result                                                                        | Availability / notes                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_search`                 | `query`; optional `limit` (default 8). Returns matching loadable tool definitions.                | Client-side BM25 search of deferred tools; requires model search support, provider namespaces, and at least one deferred searchable tool. Uses special `type: "tool_search", execution: "client"` protocol. [Schema][tool-search-spec]; [implementation][tool-search] |
| `list_mcp_resources`          | Optional `server`, `cursor`. Returns resource metadata and pagination.                            | Registered when an MCP server exists. A cursor requires a named server.                                                                                                                                                                                               |
| `list_mcp_resource_templates` | Optional `server`, `cursor`. Returns parameterized resource templates.                            | Same registration and pagination rule.                                                                                                                                                                                                                                |
| `read_mcp_resource`           | `server`, `uri`. Returns the MCP resource's contents.                                             | Routes to the selected server; it is not arbitrary URL fetching.                                                                                                                                                                                                      |
| Server-contributed MCP tools  | The server supplies names, input schemas, annotations, and result types.                          | Open-ended catalog; server/tool filters, visibility, auth, app policies, approvals, and schema budgets apply.                                                                                                                                                         |
| Client-supplied dynamic tools | Thread-supplied function or namespace schemas; calls return client `content_items` and `success`. | The embedding client must execute them. The concrete OSS TUI set appears below.                                                                                                                                                                                       |

Resource utilities call MCP `resources/list`, `resources/templates/list`, and `resources/read`; they are separate from discovering MCP **tools**. Resource access to the `codex_apps` server additionally requires `orchestrator.mcp.enabled`. [Resource schemas][mcp-resources]; [resource access policy][mcp-resource-policy]

MCP supports stdio and Streamable HTTP servers, with configured credentials/environment/headers. Tools retain their server routing even when names are normalized or namespaced for the model. Apps/connectors and plugin-contributed MCP servers add further catalogs, which cannot be enumerated from the CLI repository alone. `codex_apps` is the hosted connector server identity, not a fixed model-visible namespace or the desktop `codex_app` plugin. [MCP naming/filtering][mcp-tools]; [server configuration][mcp-config]; [exposure policies][mcp-exposure]; [dynamic tool registration][dynamic-tools]

### Plugin suggestions and installation

| Tool                                | Important input and result                                                                                                                                                                | Gate / limitation                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_available_plugins_to_install` | Empty object; returns candidate IDs, names, descriptions, kinds, and contributed capabilities.                                                                                            | `ToolSuggest`, `Apps`, and `Plugins`, nonempty candidates, and ListTool presentation.                                                                                                                                    |
| `request_plugin_install`            | Recommended-context schema: `plugin_id`, `suggest_reason`. ListTool schema: `tool_type`, `action_type: "install"`, `tool_id`, `suggest_reason`. Returns confirmation/completion metadata. | Same feature/candidate gates, root agent only; invokes host UI elicitation and verifies installation. **Plugin installation is explicitly rejected by the `codex-tui` frontend**; the legacy connector path is separate. |

These are real core schemas, but registration alone does not mean the CLI frontend can complete the request. They are not autonomous shell installers. [Suggestion schemas][plugin-schemas]; [frontend restrictions and installation flow][plugin-runtime]

### Browser and computer use

The source contains desktop integration policy flags (`browser_use`, `browser_use_full_cdp_access`, `browser_use_external`, `computer_use`, `in_app_browser`) and recognizes MCP names such as `cua_repl` for policy routing. It does **not** supply a built-in production browser/desktop action API for those names. A browser or computer-use plugin/runtime must provide capture, navigation, click/type, and other actions through MCP or dynamic tools. These flags are explicitly documented in source as desktop integration gates. [Feature definitions][computer-flags]; [MCP policy identities][computer-mcp]

FreeLM therefore needs a separately chosen cross-platform browser/computer runtime; copying Codex's tool names or enabling these flags does not supply one.

## Goals, memory, skills, and context recovery

These are extensions, not implicit features of an OpenAI-compatible generation endpoint. The app server installs extension contributors, which subsequently decide whether to expose their tools. [Extension installation][extensions]

### Persistent goals

Goals require the `Goals` feature, a state database, and an eligible thread runtime. Visibility and execution availability are distinct; execution also needs persistent thread state. Budget accounting and automatic continuation require host runtime support beyond the three schemas. [Goal schemas][goals]; [registration and availability][goal-registration]

| Tool          | Important input                               | Behavior                                                                            |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `get_goal`    | None                                          | Read objective, status, budgets, elapsed time, and token usage.                     |
| `create_goal` | `objective`; optional positive `token_budget` | Create a goal or replace a completed goal; an unfinished goal prevents replacement. |
| `update_goal` | `status`: `complete`, `blocked`, or `paused`  | Change status; this tool cannot resume a goal or change its budget.                 |

### Long-term memory store

The `memories` namespace requires `MemoryTool`, `memories.use_memories`, and `memories.dedicated_tools`. These tools access a managed memory store, not unrestricted workspace files. The local backend is included in the source. [Memory registration][memory-registration]; [tool implementations and schemas][memory-tools]

| Tool                       | Important input                                                                                                    | Behavior                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memories.list`            | Optional `path`, `cursor`, `max_results`                                                                           | List immediate files/directories with pagination.                                                                                                    |
| `memories.read`            | `path`; optional `line_offset`, `max_lines`                                                                        | Read a file using one-based line offsets.                                                                                                            |
| `memories.search`          | `queries`; optional `match_mode`, `path`, `cursor`, `context_lines`, `case_sensitive`, `normalized`, `max_results` | Search memory text with matching and pagination controls.                                                                                            |
| `memories.add_ad_hoc_note` | `filename`, `note`                                                                                                 | Create an append-only Markdown memory note with a validated timestamp/slug filename. The tool contract limits this to explicit user memory requests. |

### Skills

The dedicated `skills` tools require an available cloud or executor skill provider; cloud discovery additionally requires cloud skills to be enabled. Ordinary local `SKILL.md` instructions can also be provided through context and read through shell commands, without these tools. A skill is instruction/resources, not itself an executable tool. [Skills registration and authority types][skills]; [list/read schemas][skill-tools]

| Tool          | Important input                                                 | Behavior                                                                                    |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `skills.list` | `authority: { kind: "cloud" \| "executor" }`; optional `cursor` | Return skill metadata, package handles, primary resources, and a continuation cursor.       |
| `skills.read` | `package`; optional `resource`, `cursor`                        | Read the primary or specified package resource, with pagination and an optional skill root. |

These are the authority names in this pinned OSS release; other Codex hosts may use different schemas.

### History and scratch notes

The `history` and `notes` extensions require `token_budget.use_history_notes_extension`, an OpenAI provider, and authentication using the Codex backend. The implementation calls backend `alpha/history/v2/*` and `alpha/notes/v2/*` services. Consequently, these implementations cannot be enabled against an arbitrary inference endpoint merely by sending their tool definitions. This inventory covers their public schemas only. [Schemas and endpoint mapping][history-tools]; [provider/authentication gate][history-gate]

| Tool                         | Important input                                                                           | Behavior                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `history.list_windows`       | Optional `limit`, `agent_name`, `recent_first`                                            | List context windows for recovery.                     |
| `history.list_items`         | Optional window/agent/role/tool filters, ordering, `limit`, `max_chars_per_item`          | List bounded previews of recorded items.               |
| `history.read_item`          | `item_id`, `window_id`; optional `agent_name`, `offset_chars`, `limit_chars`              | Read a recorded item's text in chunks.                 |
| `history.search_contents`    | `query`; optional window/agent/role/tool filters and result limits                        | Search recorded content.                               |
| `notes.list_files_by_prefix` | Optional `prefix`, `max_results`, `file_order_by`, `file_order`                           | List files in the agent's virtual note store.          |
| `notes.read_file`            | `path`; optional `start_line`, `stop_line`                                                | Read note lines, including supported negative offsets. |
| `notes.search_contents`      | `query`; optional `max_matches_per_file`, `recent_file_first`, `max_files`, `path_prefix` | Search virtual notes.                                  |
| `notes.append_to_file`       | `path`, `text`                                                                            | Append to a note.                                      |
| `notes.write_file`           | `path`, `text`                                                                            | Replace a note's contents.                             |

The `notes.*` file operations are not general filesystem tools. FreeLM would need its own history and note storage to provide equivalent recovery independently of the Codex service.

## Agent message board

Alongside direct agent messaging, the optional board supplies nine tools in the configured multi-agent namespace. It requires both `AgentMessageBoard` and `MultiAgentV2`. Storage can be SQLite or in-memory; ephemeral sessions require the in-memory option. The board is scoped to an agent tree. [Board registration][board-registration]; [all nine schemas][board-tools]

| Tool suffix      | Important input                                                                                     | Behavior                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `create_channel` | `channel_name`; optional `subscribe`                                                                | Create a shared channel, subscribing the caller by default. |
| `get_channels`   | Optional `query`, `recent_first`, `limit`, `cursor`                                                 | List or find channels.                                      |
| `list_threads`   | `channel_name`; optional sort, pagination, preview limits                                           | List discussion threads within a channel.                   |
| `search_posts`   | Optional channel/query/author/after-message filters, pagination, preview limits                     | Search or browse posts and replies.                         |
| `read_thread`    | `thread_id`; optional pagination and preview limits                                                 | Read a discussion thread and replies.                       |
| `read_post`      | `message_id`; optional `offset_chars`, `limit_chars`                                                | Read a complete post in chunks.                             |
| `subscribe`      | Exactly one of `channel_name` or `thread_id`; optional `target_agent`                               | Subscribe an agent to notifications.                        |
| `unsubscribe`    | Same target fields                                                                                  | Remove a subscription.                                      |
| `post`           | `text`; exactly one of `channel_name`, `new_channel_name`, `thread_id`; optional `agents_to_notify` | Start a discussion or reply; return post metadata.          |

Notifications only reach agents with running turns; missed notifications are not stored as an inbox. These `list_threads`/`read_thread` tools refer to board discussions, not the user's saved chats.

## TUI tools for saved chats

The OSS terminal UI contains its own `codex_tui` task-management tools when connected to an external app server. These are distinct from subagents and from the desktop app's larger plugin catalog. The embedded app-server path disables this transport. The dynamic-tool transport supplies six non-delegation tools; the local MCP transport supplies all nine, including `create_thread`, `send_message_to_thread`, and `fork_thread`. [Tool schemas][tui-tools]; [transport variants][tui-transport]; [host selection][tui-host]

| Tool                               | Important input                                                                       | Behavior                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex_tui.list_threads`           | Optional `limit`                                                                      | List recent active tasks on the connected server.                                                                                                                 |
| `codex_tui.list_archived_threads`  | Optional `limit`, `cursor`                                                            | List archived tasks.                                                                                                                                              |
| `codex_tui.read_thread`            | `threadId`; optional `cursor`, `turnLimit`, `includeOutputs`, `maxOutputCharsPerItem` | Read messages and status without opening a task.                                                                                                                  |
| `codex_tui.wait_threads`           | `targets` with `threadId`/optional `afterCursor`; optional `timeoutMs`                | Wait for up to eight tasks to finish or need input/approval; zero timeout returns a snapshot.                                                                     |
| `codex_tui.send_message_to_thread` | `threadId`, `prompt`; optional `model`                                                | Send a follow-up to an existing task.                                                                                                                             |
| `codex_tui.create_thread`          | `prompt`; optional `title`, `model`                                                   | Create/start a task inheriting the working directory.                                                                                                             |
| `codex_tui.fork_thread`            | Optional `threadId`                                                                   | Fork a task without starting a turn; current task is the default.                                                                                                 |
| `codex_tui.set_thread_title`       | `title`; optional `threadId`                                                          | Rename a task.                                                                                                                                                    |
| `codex_tui.set_thread_archived`    | `archived`; optional `threadId`                                                       | Archive another task and descendants, or restore only the selected task. Archiving the calling task is rejected, even though an omitted ID defaults to that task. |

## Boundaries and commonly confused names

- Shell utilities such as `rg`, `cat`, `sed`, `git`, `python`, and package managers are programs invoked through execution tools, not separately registered Codex tools. OS availability and the execution environment determine whether they work.
- The pinned core does not register the older `shell`, `shell_command`, or `local_shell` names, or dedicated workspace `read_file`, `grep_files`, or `list_dir` tools. Use the actual `exec_command`/`write_stdin` contract as the reference; virtual `notes.read_file` is a different capability. [Core registrations][registry]
- There is no built-in dedicated `python`, `js_repl`, or `js_repl_reset` tool in this release. The `js_repl` and `js_repl_tools_only` feature keys are removed/ignored; code-mode `exec` is a separate runtime. [Legacy feature handling][legacy-features]
- Old CSV-agent-job names such as `spawn_agents_on_csv` and `report_agent_job_result` are not production tools in this release. Migration/test remnants do not establish current availability.
- The CLI's human-facing commands, slash commands, app-server RPCs, and review modes are not automatically model-callable tools. In particular, this release's CLI command enum has `mcp` for managing external MCP servers but no `mcp-server` command or `codex`/`codex-reply` server tools. Older examples should not be treated as this release's tool catalog. [CLI commands][cli-commands]
- Desktop plugin tools for worktrees, automations, app navigation, screen capture, and similar host features are not established as built-in OSS CLI tools merely because they appear in a Codex desktop session. The source-backed TUI subset above is included explicitly.

## What FreeLM has today

The following was verified against the current workspace, rather than inferred from the UI or older notes.

| Area                  | Present                                                                                        | Needed to expose equivalent capabilities                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat                  | Responses/Chat Completions text and image requests, streaming, cancellation, thinking settings | Tool schemas, streamed argument assembly, call IDs, dispatch, tool results, and repeated model turns until completion.                                                           |
| Conversation records  | User/assistant text, attachments, model/mode, errors                                           | Structured tool calls/results, execution status, approvals, plans, and resumable agent state.                                                                                    |
| Desktop host          | Validated Electron IPC, isolated renderer, HTTP transport, persistence                         | Workspace-aware command/PTY execution, patching, filesystem access, execution permissions, and process lifecycle management. Renderer sandboxing is not a shell-command sandbox. |
| Remote FreeLM         | Host workspace access, API credential ownership, provider request forwarding                   | Remote capability discovery, tool execution/session IDs, streamed tool output, cancellation, and reconnect behavior.                                                             |
| Media                 | Image generation/editing, video, speech, transcription playground adapters                     | Model-callable wrappers and tool-result/media rendering. Existing playground actions are not tools available to chat.                                                            |
| External integrations | Provider connections and external-link handling                                                | MCP client/server lifecycle, browser/computer runtimes, and configurable search/generation backends.                                                                             |

Evidence in FreeLM:

- [Request construction](../src/lib/api.ts) (`streamChat`, around lines 305–349) sends conversation content without tool definitions; the function performs one provider POST around line 424.
- [Stream handling](../src/lib/api.ts) (around lines 404–463) renders text/refusal and completion, but does not execute function calls. Chat `finish_reason: "tool_calls"` is treated as terminal. A response containing only calls raises “This prototype does not execute tool calls yet”; a mixed text/tool response can display text while ignoring calls.
- [Stored message and project types](../src/types.ts) (`Message` at line 52, `Project` at line 75) lack tool exchanges and filesystem workspace policies. [Thinking overrides](../src/lib/catalog.ts) reserve tool-control fields instead of permitting them as arbitrary model settings.
- [Preload IPC](../electron/preload.ts) exposes requests, storage, and instance operations, with no tool executor. [Main-process setup](../electron/main.ts) validates callers and isolates the renderer.
- [Remote host](../electron/instance-host.ts) exposes `/info`, `/workspace`, `/request`, and `/asset`; `/request` forwards allowed provider APIs using host credentials. It is not a remote shell or durable agent runtime.
- [Workspace authority](../electron/workspace-authority.ts) already protects host credentials, rejects stale revisions, and persists before publishing a revision. Those rules should remain separate from future tool permissions.

For the next implementation discussion, the dependency is: structured tool exchanges and a provider-compatible continuation loop, then a host-side capability/execution boundary, user-facing activity/approval handling, and local/remote tool adapters. Tool names alone do not supply those behaviors. OpenAI-hosted tools will need replaceable backends to preserve FreeLM's arbitrary-provider goal; media generation can build on FreeLM's existing adapters.

No FreeLM runtime code or inference-service settings were changed for this inventory. Validation here is source inspection, not execution of the upstream tools or provider compatibility testing.

## Source references

Every GitHub source link below is pinned to the inspected release commit. The official [CLI overview](https://learn.chatgpt.com/docs/codex/cli) and [MCP overview](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) were used for terminology; the source registrations determine this inventory.

[registry]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/spec_plan.rs#L1015
[extensions]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/app-server/src/extensions.rs#L50
[goals]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/goal/src/spec.rs#L9
[goal-registration]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/goal/src/extension.rs#L96
[memory-registration]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/memories/src/extension.rs#L135
[memory-tools]: https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/memories/src/tools
[skills]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/skills/src/tools/mod.rs#L55
[skill-tools]: https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/skills/src/tools
[history-tools]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/history-notes/src/tools.rs#L25
[history-gate]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/history-notes/src/extension.rs#L45
[board-registration]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/agent_message_board.rs#L34
[board-tools]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/agent-message-board/src/tools/spec.rs#L10
[tui-tools]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/dynamic_tools.rs#L150
[tui-transport]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/dynamic_tools_mcp.rs#L54
[tui-host]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/app_server_session.rs#L439
[cli-commands]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/cli/src/main.rs#L143
[handlers]: https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers
[shell-spec]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/shell_spec.rs#L24
[one-shot]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L484
[code-mode]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/spec_plan.rs#L819
[code-mode-contract]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/code-mode-protocol/src/description.rs#L20
[agent-selection]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/config/mod.rs#L1574
[agent-spec]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L65
[agent-registration]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/spec_plan.rs#L1299
[hosted-web]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/hosted_spec.rs#L14
[web-schema]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-api/src/search.rs#L32
[web-runtime]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/web-search/src/tool.rs#L97
[web-gate]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/web-search/src/extension.rs#L42
[image-tool]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/image-generation/src/tool.rs#L58
[image-gate]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/spec_plan.rs#L727
[tool-search-spec]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/tool_search_spec.rs#L16
[tool-search]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/tool_search.rs#L192
[mcp-resources]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L7
[mcp-resource-policy]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/mcp_resource.rs#L45
[mcp-tools]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/codex-mcp/src/tools.rs#L25
[mcp-config]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/config/src/mcp_types.rs#L233
[mcp-exposure]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/mcp_tool_exposure.rs#L79
[dynamic-tools]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/spec_plan.rs#L1425
[plugin-schemas]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/request_plugin_install_spec.rs#L10
[plugin-runtime]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/core/src/tools/handlers/request_plugin_install.rs#L117
[computer-flags]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/features/src/lib.rs#L253
[computer-mcp]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/protocol/src/mcp.rs#L35
[legacy-features]: https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/features/src/lib.rs#L593
