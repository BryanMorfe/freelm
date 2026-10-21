# Code tools, images, web browsing, and isolated Python

FreeLM’s **Code** workspace runs an agent loop with Responses or Chat Completions: offer tools, collect complete calls, execute them, send matching results, and continue the response. Tool activity and provider replay items are saved with each assistant message. **Chat** is a separate workspace for conversations. It can generate images through the configured API, browse public web pages through a configured SearXNG service, and run Python in an isolated interpreter when enabled. Chat cannot run local-machine commands, access user files, connect arbitrary MCP servers, or load skills. Explicitly granted account-connected [plugin tools](PLUGINS.md) are separately available in Chat, Code, and selected Bots. Code tasks with tools disabled use ordinary text and image requests.

## Setup

Open **Settings → Personal → Tools** to configure Code tools. New profiles enable Code tools and command execution by default; existing disabled settings stay disabled. The Code composer chooses the current task’s permission mode, project, and execution host. Chat image generation and web browsing have independent switches.

1. **Enable tools in Code** controls the Code agent loop. Keep it on for work tasks, or turn it off in Settings. This switch does not control Chat image generation or Chat web browsing.
2. **Run commands** controls shell execution and file changes. Bind folders in a Code project, or optionally choose a default working directory for Code tasks outside a project. A blank default starts in the execution host’s home directory.
3. Choose **Ask for approval**, **Approve for me**, or **Full access**. The Settings value is the default for new Code tasks; the composer controls the current task. See [Code permissions](CODE_PERMISSIONS.md) for review behavior and limits.
4. For image generation, enable **Generate images in Chat and Code** and select its API connection and image model. Chat can use this independently of **Enable tools in Code**; Code requires both switches. The model can be selected from the image catalog or entered manually. The saved size is an optional fallback; each tool call can choose its own size. Quality remains a saved provider value.
5. For web browsing, open **Settings → Personal → Search**, choose the built-in service or an external **SearXNG URL**, and enable **Browse the web in Chat and Code**. Chat does not require the Code switch; Code requires both switches.
6. Add integrations under **MCP servers** and **Skills**, then save settings.

The model selected for tools must support function calling. FreeLM uses ordinary JSON function tools with deterministic API-safe names for both endpoints; it does not require provider-specific hosted tool search, namespaces, or OpenAI-hosted image tools.

## Project folders and execution

Create or edit a Code project to choose 1–32 folders, using **Add folder** or one absolute path per line. The first folder supplies the default command working directory and resolves relative file paths. Project folders identify the work’s focus. Commands and file tools may operate elsewhere on the execution host, subject to the task’s permission mode and the host account’s access. Folder paths are checked when a tool uses them.

Code tasks outside a project use **Default working directory** in **Settings → Personal → Tools**, falling back to the host’s home directory when blank. Code projects use their own bound folders as the starting location. Binding folders leaves execution enablement and approval policy unchanged. Changing a running task’s project bindings stops the run; send another message to use the updated folders. Chat projects organize conversation instructions without filesystem bindings.

On a remote FreeLM workspace, folders refer to the host computer and are managed there. Connected clients can start a new Code task in an existing host Code project, but cannot change its folder bindings or move an existing task between projects. Remove projects containing conversations on the host as well.

## Computer Use

Opt-in Computer Use lets local Code tasks discover and control applications, with app mentions, per-run authorization, a live preview, and Stop. macOS requires Accessibility and Screen Recording permissions. Linux currently supports X11. See [Computer Use](COMPUTER_USE.md) for setup, tools, permission behavior, and platform limitations.

## Existing workspaces

Existing tool configuration is retained. Legacy projects with bound folders appear in Code. Legacy conversations containing tool calls or agent transcripts, or belonging to a Code project, appear as Code tasks; ordinary conversations remain in Chat. Explicit saved Chat/Code classifications take precedence. Migration preserves messages, project links, and tool history. If a legacy tool conversation belonged to an unbound Chat project, it appears in Code with its project link preserved; move it into a Code project to assign filesystem folders.

## Code behavior and repository instructions

Code has a dedicated working-behavior prompt, separate from personality settings and tool guidance. It covers task completion, steering, editing safety, planning and appropriate verification. Scoped `AGENTS.md` / `AGENTS.override.md` files are discovered on the execution host. Repository rules, project instructions, saved memory and selected references are supplied as source-labelled user context and are visible alongside the system prompt in Settings. See [Code instructions and context](CODE_PROMPTS.md) for discovery boundaries, precedence, provider mapping and compaction behavior.

## Tools available in Code

| Capability       | Tools                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Commands         | `exec_command`, `write_stdin`                                                          |
| Files and images | `apply_patch`, `view_image`                                                            |
| Interaction      | `update_plan`, `request_user_input`, `send_message_to_user_async`                      |
| Time             | `clock.curr_time`, `clock.sleep`                                                       |
| Generated images | `image_gen.imagegen`                                                                   |
| Generated videos | `video_gen.videogen` (direct call, configured in Settings → Tools)                     |
| Web browsing     | `web.run`                                                                              |
| Computer Use     | `computer_apps`, `computer_open`, `computer_observe`, `computer_act`, `computer_close` |
| Discovery        | `tool_search`                                                                          |
| MCP resources    | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`               |
| Skills           | `skills.list`, `skills.read`                                                           |
| MCP tools        | Names and schemas contributed by each configured server                                |

Commands can yield a process session ID, then receive input or be polled with `write_stdin`. Output is bounded and commands have a 30-minute lifetime. Stop, workspace switching, app shutdown, and completion of the agent run clean up its processes. Run long-lived commands in the foreground and use their yielded session; detached daemons are not retained. This build uses pipes, not PTYs; `tty: true` reports an explicit error.

`apply_patch` accepts the Codex-style patch body in a JSON `patch` field for compatibility with function-calling providers. File add/update/delete/move and context hunks are supported. Absolute paths can refer to files outside the project folders when approved. **Code processes run with the host user’s permissions, without OS sandbox isolation**; the working directory is a starting location. Approval decides whether an action runs; it does not restrict the process after launch. Declined actions return a tool error and reason to the model without executing.

Completed Code responses show an **Edited files** summary below the answer. It combines successful recorded file changes for that response, showing all paths when there are up to five files. Larger summaries initially show three files, with **Show more files** to expand the rest. Hover, focus, or click a file to inspect its recorded patch previews; Escape or clicking outside closes the preview. Repeated edits contribute to the accumulated counts, and previews follow renames. Failed or declined patches are excluded. Older records with unavailable counts or previews say so rather than inventing them. This is a summary of tool-recorded edits, not a live Git diff: shell commands and external tools that do not return file-change metadata cannot be reconstructed from their output.

The right panel shows **Outputs** above **Sources**. The top-bar toggle controls this panel; “Pinned summary” is its internal name, not a visible heading. Outputs accumulates newly created files throughout the task, including work from earlier response versions, committed patches, filesystem changes observed around approved commands and interactive polls, and returned file assets. Existing-file edits do not create output rows; renames update paths and confirmed deletions remove rows. Uploaded references and viewed/search images remain Sources. Generated images and downloadable tool artifacts can appear in Outputs in Chat as well.

Outputs shows only local files the execution host verifies still exist, deduplicating canonical paths and physical file identities. Different files with the same name remain separate, with project-relative paths that distinguish their directories. While the panel is open, metadata refreshes every five seconds and on window focus; this does not read file contents. Missing, unsafe, or unverified local files are hidden, and verification failures are explained. Embedded downloadable artifacts remain available independently of their original filesystem location.

Click an output to preview or download it. Local file contents are read only on selection, within the execution host’s configured task directories, with an 8 MiB read/download limit and 256 KiB plain-text preview. Existing oversized files retain their path with an explanation. Remote verification and previews run on the selected host and require an updated FreeLM instance; they never fall back to the local machine.

Command discovery observes assigned project directories and explicit command workdirs with bounded asynchronous metadata scans. It excludes dependencies, caches, and symlinks, and does not scan an unbound task’s default home directory. Discovery limits are available under **Output discovery details**. Simultaneous writes by a user or another task in the same folders can also be observed; the list is not a filesystem audit or proof of which process created a file. Absolute writes elsewhere, work before this feature, and creations after the last poll before Stop may not be discoverable.

Plans and questions appear in the conversation. Questions support suggested choices and free-text answers; Stop cancels a pending question. Clock sleep is capped at 60 seconds per call. The agent loop has no fixed turn limit; individual calls, arguments, outputs, and image payloads have bounds.

Permission-profile sandbox negotiation, Codex internal test tools, and subagents are not implemented. The orchestration and explicit context controls described below are separate runtime capabilities from shell execution.

## Persistent Code goals and knowledge

Code provides `create_goal`, `get_goal`, and `update_goal`. A goal belongs to one task and survives app restarts and context compaction. Type `/goal`, select **Goal**, and submit the objective in the Code composer, or explicitly ask the model to create one. The goal controls show status and token usage, with Pause, Resume, Clear, and budget adjustment. A missing budget means no token budget. Actual provider input/output usage is used when supplied; otherwise usage includes clearly marked local estimates.

An active goal continues after a successful response only when the task is idle, no input is queued, and the objective remains active. Completion requires model verification. Stop pauses the goal; request failures and a continuation without tool calls require Resume rather than spinning. Restart preserves the goal but waits for Resume. A token budget stops further continuation at a complete tool boundary; reaching it does not mark the objective complete. The current model request and its matching tool results can finish before that boundary.

Code memory is separate from Chat memories. `memories.list`, `read`, `search`, `add_ad_hoc_note`, `update`, and `delete` manage Markdown documents under `~/.freelm/code/memories/`, scoped by the assigned project (or the workspace for projectless tasks). Each scope has a `MEMORY.md` index, supplied with bounded content as source-labelled user context. Project-root `MEMORY.md` files are also read as context; these tools do not edit project files. Edit a project's file through the normal approved file tools. Memory writes should follow explicit user requests. Stored and project memory is reference data, not higher-priority instructions.

`notes.list_files_by_prefix`, `read_file`, `search_contents`, `write_file`, `append_to_file`, and `delete` maintain task-local scratch Markdown under `~/.freelm/code/tasks/`. Notes survive turns, reloads and context changes. They do not automatically become cross-task memory. Reads/searches are bounded and paginated; replacement/deletion uses content revisions, and writes are atomic. Configured `FREELM_HOME` and remote execution hosts own their respective stores.

`history.list_windows`, `list_items`, `read_item`, and `search_contents` recover the task's original messages and tool results, including inactive branches and content from before compaction. Each compaction/reset records a recovery boundary while leaving original replay items intact. This is a local implementation of the Codex history/notes contracts; FreeLM does not call the Codex-only hosted history/notes services.

## Code orchestration, context controls, and tasks

`functions.exec` accepts JSON `{ "code": "..." }` for compatibility with arbitrary function-calling APIs. It runs JavaScript in a QuickJS WASM interpreter on a worker, without Node, filesystem, network, imports, or console access. Call tools through normalized names such as `await tools.exec_command({cmd: "pwd"})`; every call re-enters ordinary host scope and approval checks. `ALL_TOOLS` exposes available names/descriptions, and `Promise.all` or `Promise.allSettled` can compose independent calls. `text`, `image`, `audio`, `generatedImage`, `notify`, `store/load`, timers, `exit`, and `yield_control` provide bounded outputs and run-local state. Persistent working state belongs in notes.

Long cells return a cell ID; `functions.wait` retrieves only new output, completion/errors, or terminates the cell. Stop and termination cancel pending work. Completed shell sessions remain attached to the Code run. Cells have CPU/memory/output bounds and a 30-minute wall-clock lifetime. Questions, goal/task lifecycle, permissions and context tools are direct-call only. Scripts cannot bypass permissions by nesting tools.

`get_context_remaining` reports configured model capacity and estimated remaining tokens corrected by available provider usage. It does not claim exact tokenizer accounting. `new_context` installs a fresh context at the completed tool boundary without generating a summary, retaining the latest user request and the current complete tool exchange. Original history, memory, notes, and execution sessions remain accessible. Automatic compaction continues to work independently.

`tasks.list_threads`, `list_archived_threads`, `read_thread`, `wait_threads`, `create_thread`, `fork_thread`, `send_message_to_thread`, `set_thread_title`, and `set_thread_archived` operate on Code tasks in the selected workspace. Starts, follow-ups, forks and archive changes use the task's approval policy and user-authorization guidance. Creating a task inherits its caller's project, API connection, model, thinking mode and permissions. Follow-ups are persisted before delivery and use the target task's saved configuration. They run independently without changing the open conversation. Forks end at completed assistant replies and do not start execution. Reads are bounded and omit provider replay/media and configured credentials. Archiving stops affected work; the calling task cannot archive itself. Tools never fall back from a remote workspace to local execution.

Implementation references: [Codex goal extension](https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/goal), [memory extension](https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/memories), [history/notes contracts](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/history-notes/src/tools.rs), [code-mode protocol](https://github.com/openai/codex/tree/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/code-mode-protocol), and [TUI task tools](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/tui/src/dynamic_tools.rs).

## Image generation from Chat and Code

The image tool uses its own saved connection/model, independently of the text model and the image playground's current selection. It uses `/images/generations` or `/images/edits` with uploaded or recently generated conversation images. Chat requests cannot reference host filesystem paths. Code can also use image paths on its execution host when the image tool action is approved. Relative paths start from the task’s working directory; absolute paths can refer outside the project folders. It supports up to five references and a transparency request when the provider supports it. Provider-returned image URLs are fetched on the execution host without forwarding API credentials.

The model can pass `size: "WIDTHxHEIGHT"` or `size: "auto"` for each generation or edit, including edits from uploaded Chat images. For example, `{ "prompt": "Change the background to a park", "num_last_images_to_include": 1, "size": "1792x2400" }` sends that size to `/images/edits` as a multipart field. Omit it to use **Default image size**, or the provider default when that is blank. Explicit dimensions must be positive whole numbers; FreeLM sends them without rounding or limiting them to the recommendations. The provider decides which sizes it supports.

The tool schema includes the selected image model's editable aspect-ratio/resolution pairs from **Settings → Configuration → Models**, using the configured API quality. It identifies the preferred preset and explains square, portrait, landscape, and reference-preserving edits. For edits with no requested dimensions or saved size, the model is instructed to explicitly choose a recommended resolution matching the reference aspect ratio, since omitting size can select a lower-resolution provider default. Model-context previews are not the original image resolution. This is model guidance; FreeLM does not silently force a size onto an omitted or automatic request. **Tools → Image size guidance** previews this guidance. Custom model IDs without configured presets receive instructions to use the provider default unless the user requests dimensions. Changing the selected model's guidance during a run stops the stale run; send a new message to use the changes. Model, API connection, and quality remain host-owned settings.

Generated images appear in the conversation and the Images gallery. Click the conversation image to enlarge it; click the blurred background or close button to dismiss. Images can be downloaded. Models declared as text-only receive a textual result while the image remains visible to the user; image-capable models can receive image tool results.

## Isolated Python in Chat

Enable **Settings → Personal → Tools → Run Python in Chat**. This is separate from Code command execution and does not require the Code tools switch. **Check Python runtime** starts an isolated, empty interpreter, reports its Python version and available analysis libraries, and cleans it up. Scientific libraries are optional; the bundled interpreter currently provides standard-library computation and file creation without downloading packages.

`python.exec` accepts `code` and an optional `timeout_ms` between 100 and 120,000 milliseconds, defaulting to 30,000. The last expression, bounded stdout/stderr, and errors are returned. Each conversation has its own persistent interpreter and variables. Stop during a call, execution timeout, app shutdown, or 30 minutes of inactivity resets the interpreter. A later message in the same conversation reuses an active interpreter; different conversations can execute independently. Up to eight sessions may be active.

Save output files in the interpreter's current directory using plain filenames. New or changed files are returned automatically, with up to eight files and 8 MiB total per call. Originals are downloadable attachments. Valid PNG, JPEG, and WebP outputs also receive a decoded preview with a maximum edge of 1600 pixels; source images above 16 megapixels, malformed images, GIFs, and other image types remain downloads without inline/model pixels. Decoding runs in a separate bounded worker. Nested directories, hidden files, symlinks, and oversized files are not returned. A host monitor checks aggregate output/scratch storage while the session exists and resets it above 64 MiB or 512 entries; traversal is bounded and nested directories are limited to eight levels. The interpreter cannot read uploaded or host files directly; provide relevant data in the Python code. It cannot access network services, install packages, or launch shell commands.

macOS uses `sandbox-exec` with a default-deny policy, read-only interpreter/system-library access, and writes confined to its private output directories. Linux uses bubblewrap with separate user, mount, PID, IPC, and network namespaces, read-only runtime mounts, dropped capabilities, and an irreversible seccomp filter denying process execution/creation, networking syscalls, and namespace changes after interpreter startup. Linux requires `bwrap` and permitted unprivileged user namespaces. Missing or rejected isolation fails closed without running model code. Remote FreeLM sessions execute Python on their selected host; no local fallback occurs.

Run `npx vitest run tests/python-tools.test.ts` for schema and fail-closed checks. On the desktop host, `FREELM_NATIVE_PYTHON_SANDBOX=1 npx vitest run tests/python-tools.test.ts` also verifies real interpreter persistence, user-home read denial, native process denial, network denial, hard-link/symlink output protection, bounded output, timeout reset, cancellation, and temporary-directory cleanup. macOS native checks do not establish Linux readiness.

## Web browsing through SearXNG

In **Settings → Personal → Search**, choose **Built-in** or **External**, enable browsing, and save. New profiles default to the built-in choice with browsing disabled. Existing external configurations retain their URL and mode. Search configuration is separate from model API connections and stays in the host's `~/.freelm/config.json` tool settings.

### Bundled search service

Choose text and image engines, save, and click **Start**. The bundled SearXNG helper runs on an allocated loopback port in a separate process, using its own native Python runtime. It needs neither Docker nor system Python. The selected engine names form the service allowlist, including explicit engine selection in queries. Changing engines while running restarts the helper after settings are saved. Recent bounded logs and startup errors appear on the Search page.

**Start with FreeLM** starts the service when browsing is enabled and Built-in is selected. Manual **Stop** remains effective for the current app session; a tool call does not silently restart it. Quitting FreeLM stops the helper. Closing the last macOS window keeps it available while FreeLM remains running; on Linux, closing the last window quits the app. Search settings on a remote workspace are controlled by its host, and search execution uses the host's service.

The helper stores its private secret, generated `settings.yml`, cache, temporary files, and bounded logs under `~/.freelm/search` (or `<FREELM_HOME>/search`). Engine choices are saved in `config.json`; `settings.yml` is regenerated on startup from those choices. API keys are not passed to the search process. Readiness checks verify the instance identity as well as health and engine discovery.

`scripts/prepare-search-runtime.mjs` stages immutable SearXNG revision `3cd69d30e2a78dfc817be9e349e7c2e4317c92e3`, Python 3.12.14, exact dependency wheels, and upstream notices, with SHA-256 verification. Official artifact URLs and hashes are recorded in `resources/search/manifest.json`; the full SearXNG source, license, and Python/dependency notices travel with packaged apps. Preparation supports Apple Silicon, Intel macOS, and Linux ARM64/x64. Execute release checks on the target operating system; macOS validation does not establish Linux desktop readiness.

### External search service

Choose **External**, enter the service URL, for example `http://your-search-host:8080` or `https://search.example.com/searxng/`, discover engines, enable browsing, and save. An explicit `/search` URL is also accepted. FreeLM preserves proxy prefixes and sends search requests to `/search` with `q` and `format=json`.

Enable JSON results on your SearXNG server:

```yaml
search:
  formats:
    - html
    - json
```

The [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) documents the JSON format and request parameters. A disabled JSON format commonly returns HTTP 403; FreeLM reports that configuration issue rather than treating the HTML error page as search results.

Use **Discover search engines** to read the selected service's `/config` and `/healthz` endpoints without saving or enabling it. The result lists the installed version, categories, and engine capabilities. An engine disabled by default can still be explicitly selected. A healthy web process does not establish that its upstream search providers work.

The built-in `web.run` function supports `search_query`, `image_query`, `open`, `click`, `find`, and PDF `screenshot`. Search returns titles, snippets, source URLs, references, and provider diagnostics. Open reads public HTML, plain text, and PDFs with numbered lines and links. Click follows a numbered link, and Find locates text in a document. PDF page indexes are zero-based for `open.pageno` and `screenshot.pageno`; screenshots appear as viewable images and are supplied to image-capable models. Image search returns source and image URLs with available metadata; it does not download the remote images or establish reuse rights. References belong to the active run; use the source URL to revisit a document in a later message. Tool instructions guide the model to read relevant sources and cite them with ordinary Markdown links near supported claims. Searches, page reading, image searches, and PDF screenshots appear as tool activity in the conversation.

Search fields include exact configured `engines`, optional `categories` for text search, `page`, `limit`, `language`, `time_range` (`day`, `week`, `month`, `year`), `safesearch`, and `timeout_limit`. FreeLM validates explicitly selected engines and categories against discovery. Native engine/category selection is additive; combining them can broaden a search. Without either selection, ordinary text searches use `general`; image searches select discovered image engines. Time-filtered searches select compatible engines when no providers were explicitly requested. Provider support declarations do not guarantee that a request will succeed.

`page` becomes the native `pageno` parameter, while `limit` is a FreeLM result cap applied after filtering. FreeLM does not send invented server count/cursor parameters or manufacture totals and continuation guarantees. Search query syntax can affect engine selection. Results preserve `unresponsive_engines`, including CAPTCHA and rate-limit errors, even when some sources were returned. Empty results can indicate degraded providers.

`domains` and `blocked_domains` add query hints and enforce hostname matching on returned results, including dot-delimited subdomains; blocked domains win. Optional inclusive `start_date`/`end_date` bounds and `recency` filter the engine's publication metadata in FreeLM. Unknown dates are excluded and reported. Those dates are not independently verified, do not establish image creation dates, and do not distinguish arXiv first-submission and revision dates. Relative `time_range` is a provider hint, rather than a strict date guarantee.

This is read-only page retrieval. It does not run page JavaScript, log into websites, use browser cookies, or automate interactive pages. Search requests use only the configured SearXNG service; page requests never receive your model API credentials. The SearXNG service may be on your LAN, while retrieved pages must resolve to public HTTP(S) addresses. Response sizes, source caches, and request lifetimes are bounded. Stop and configuration changes cancel the run; retrieved content cannot change settings or grant local tool access.

The native SearXNG service supplies search and discovery, not `/open`, `/read`, extraction, or paper-service endpoints. FreeLM fetches and processes the documents on the selected FreeLM host. PDF extraction and rendering run in a separate worker with cancellation and size/page limits; scanned pages can be viewed with screenshots, but text extraction does not perform OCR. The separate OSS-agent research adapter and arXiv service described in the deployment specification are not required or called by this integration. Specialized finance, weather, and sports feeds remain outside this browsing tool.

## MCP servers and discovery

Settings supports local **stdio** servers (executable plus one argument per line) and **Streamable HTTP** servers. Optional HTTP bearer authentication uses an environment-variable name on the host, not a raw token in the workspace. OAuth login and legacy HTTP+SSE transport are not part of this pass.

**Discover tools** connects enabled servers. Starting stdio servers executes their configured programs, so Settings discovery asks for approval. During a Code task, connection and tool approvals use its selected permission mode. Server/tool errors appear in the discovered catalog or as tool results. The runtime handles schema pagination, resource pagination, request timeouts, cancellation, and configuration changes.

MCP tools are deferred: `tool_search` returns matching definitions, which become callable on the next model request. The registry assigns stable names and retains the original server/tool routing. Discovery does not authorize execution; MCP actions still use host approval policy. Resources and tool results are treated as untrusted data. No server configuration or credential may be supplied by the model.

## Skills

Add an absolute skills directory, or a directory containing one `SKILL.md`. A collection directory is scanned one child-directory level deep. FreeLM reads metadata first and supplies names/descriptions in the agent instructions; `skills.read` loads the selected skill and referenced resources on demand.

```text
my-skills/
  project-conventions/
    SKILL.md
    references/
      testing.md
```

```markdown
---
name: project-conventions
description: Use when changing this project's source or tests.
---

Read references/testing.md before running project checks.
```

Skill resource reads are bounded and confined to the skill directory. YAML aliases and escaping symlinks are rejected. Skills do not automatically execute scripts or add permissions: a script must be run through an enabled command tool and its approval policy. Codex's own skill folders are not imported automatically.

## Remote FreeLM

Tool configuration belongs to the execution host and is read-only on connected clients. Enable **Allow connected FreeLM clients to use these tools** on the host to opt in to remote Code work tools. Chat image generation and web browsing follow their own enabled settings. Both machines need a version providing the capability. Hosts advertise support for the Chat/Code boundary during pairing; the client blocks tool discovery and execution on older hosts before they can start local services. Ordinary chat and media playground requests remain available on older hosts. Local and remote run IDs are isolated; commands, skills, MCP servers, credentials, generated-image requests, and searches run on the selected host. There is no fallback to executing a remote task locally.

In Ask for approval mode, the **host’s FreeLM window** receives approval requests. Approve for me uses the Code task’s selected API/model for a separate review. Full access is an explicit per-task choice. Legacy `trusted` settings are interpreted as Full access. The host still controls whether remote clients may use Code tools. Stop and connection loss during an active request cancel host work. Remote tool runs are connection-oriented, not durable background jobs or resumable cross-app sessions.

## References and validation

The [pinned Codex source inventory](codex-tool-inventory.md) guided the tool contracts. The [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling) supplies the call/result continuation model; [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [skill concepts](https://developers.openai.com/plugins/concepts/skills) guided the integration and progressive instruction loading. The MCP runtime uses the official TypeScript SDK.

Automated coverage uses isolated shell/filesystem fixtures, local MCP stdio/HTTP servers, and mock Responses/Chat/image APIs. This verifies FreeLM's implementation, not whether a particular inference model follows tool schemas or supports image outputs. Real-provider and Linux desktop qualification remain separate checks.

Run `npm test` for protocol/runtime coverage and `npm run test:tools` after `npm run build` for the Electron Code task → command → approval → question → image flow. The desktop check uses a temporary profile and local mock provider; it does not change your saved tool configuration.

Run `npm run test:web` after `npm run build` to verify Chat web tool calls through Electron, both API formats, a local SearXNG-shaped search fixture, rendered citations, and persisted tool replay after restart. It uses a temporary profile and mock model APIs; it does not qualify your live SearXNG service or inference models.

After preparing the runtime and building, `npm run test:search` checks the real bundled helper through Electron IPC in a temporary home: offline engine selection, text/image searches, applying engine changes, Stop, automatic startup, quit/restart, and switching to an external service. It sends live public search queries but makes no model API calls. Set `FREELM_TEST_ELECTRON` to a packaged FreeLM executable to qualify its bundled interpreter and dependencies; quit the regular app first because packaged instances share its desktop single-instance lock. The smoke check asserts its temporary storage location before writing fixture data.

For an opt-in live host check, run `FREELM_LIVE_SEARXNG=http://your-search-host:8080 npm run test:web:live` after building. This uses real Electron IPC, your search service, public documentation, and a public test PDF, with a temporary home and no model API requests. It verifies discovery, text/image search, page navigation, and native PDF extraction/rendering. Set `FREELM_TEST_ELECTRON` to a packaged FreeLM executable to check the packaged worker/dependencies as well; quit your regular FreeLM app first because packaged instances share the desktop single-instance lock. The check asserts its temporary storage location before writing fixture data. Live search results and provider availability can vary; failure diagnostics are included in the report.

## Code composer modes and references

Type `/goal` or `/plan` and select the suggestion to set the next input’s mode. Goal creates a persistent objective from the submitted text; the chip clears after sending. Plan remains selected until removed, adds a read-only planning workflow, and offers **Implement plan** beneath a completed proposed plan. Full access does not override Plan mode. Read-only shell commands use a deliberately bounded literal-command subset; scripts, writes and ambiguous external actions require leaving Plan mode.

Use `/skill-name` within prose for an inline configured skill, or `@` for files/folders, skills and the available composer actions. File/folder discovery uses the task’s host and project directories, including remote workspaces; it does not upload file contents. The host checks each submitted reference again. Selected skills resolve exact configured IDs and load bounded instructions. Invalid, removed or out-of-scope references return an error rather than being guessed or resolved on another computer. Modes and references are retained in drafts, queued prompts and history. These additions do not grant Chat access to local files or skills.
