# FreeLM

A local-first desktop workspace for macOS and Linux. ChatGPT-inspired navigation, separate Chat conversations and Code tasks, persistent projects, and dedicated image, video, speech, and transcription playgrounds, connected to your own OpenAI-compatible APIs.

FreeLM is under active development and is not yet an official release. The planned promotional site and downloads will live at **freelm.ai** once the app is ready.

## Run

Requires Node.js 22.12+ and npm.

```bash
npm ci
npm run dev:desktop
```

For the browser preview, use `npm run dev` and open <http://127.0.0.1:5173>. Preview calls require your API to allow browser CORS. The desktop app makes requests in Electron's main process and does not require CORS changes on your server.

### Live component gallery

Run `npm run storybook` and open <http://127.0.0.1:6006> to edit individual UI components with live feedback. The gallery imports FreeLM's actual React components, application CSS, shell tokens, and appearance resolver. Save a component or CSS file in your editor to update its preview without rebuilding Electron.

- Browse Controls, Settings, Navigation, Composer, Conversation, Summaries, Media, and Bots. Each story is a useful component state; **Start here → Live editing** explains the workflow.
- Use **Theme** and **Accent** in the toolbar to check dark/light appearance and app accent colors. Use the viewport tool for narrow, compact, and desktop widths.
- Use **Controls** below the preview to vary props, then interact with the real component: open menus, edit drafts, expand diffs, retry a sample queue, or open the image viewer. Stories with an already-open menu/editor run their setup in Canvas; inline Docs starts at the component's initial state.
- Edit `src/components/*.tsx` and their CSS to change the app. Global styles and tokens are in `src/styles.css`; shared shell surfaces are in `src/components/sidebar.css`. The Docs page for each group identifies its component/style files. Preview Controls and browser inspector tweaks do not automatically persist into source.
- Examples use synthetic data and local callbacks. They do not load your profile, call your models, or execute tools. Copy/download actions only export the example content when clicked. Native dialogs, actual provider requests, and desktop tools still need validation in Electron.

Stories and fixtures live in `src/stories/`; gallery configuration is in `.storybook/`. To add a state, create a typed `*.stories.tsx` file importing an existing component. Keep fixtures local and preserve the typography rules in [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md). For interactive controlled props, use Storybook's `useArgs` or a small stateful wrapper that responds to Controls changes.

`npm run typecheck:storybook` checks stories/configuration. `npm run build-storybook` also produces a static gallery in `storybook-static/`. Storybook binds only to loopback, disables telemetry, and stays separate from the packaged app. The installed desktop app picks up source changes after its next rebuild; the gallery previews them immediately.

For a production build:

```bash
npm run build
npm start
```

## Connect a provider

1. Open **Settings** using the gear at the bottom of the icon rail, then choose **Connections** under **Personal**.
2. Set an API base URL, including any prefix, such as `http://localhost:8000/v1` or `https://api.openai.com/v1`.
3. Enter a bearer API key if the server requires it.
4. Choose **Responses**, **Chat Completions**, or the shorter **/chat** alias.
5. Choose **Configuration → Discover models** to call `/models`. Every discovered model appears in a searchable list. Click its **Configure** button to set capabilities and choose which playgrounds should use it by default. **Add model** also accepts a manual API ID.
6. Click **Save settings**, then **Back to workspace**. Each playground also accepts an editable model ID.

On macOS, allow FreeLM to access your local network when connecting to a LAN server. If the app reports a network access error while the same URL works in Terminal, check **System Settings → Privacy & Security → Local Network → FreeLM**. Model discovery does not load a model. Individual API requests allow up to 30 minutes, including a model's first-load time, for both direct API connections and remote FreeLM instances. Asynchronous video jobs are checked through separate status requests and have no total polling deadline in FreeLM.

You can save multiple connections. Selecting a connection in settings makes it active. The Chat and Code titlebar offers a quick connection switcher. Model discovery is optional: some servers do not expose `/models`. Discovery supplies raw IDs because OpenAI-style model lists do not reliably describe capabilities. Catalog declarations filter those IDs in each model chooser.

The icon rail switches between Chat, Code, Images, Video, and Audio. The adjacent panel groups threads under their projects, with standalone conversations in **Recents**. Use the titlebar's sidebar button to collapse or expand the panel; navigation stays available in the rail. Project chevrons expand and collapse their threads. Each project has a **New chat / New task** action; selecting a project opens its welcome screen. Drag conversations into projects of the same kind, or choose **Move to project** from the conversation menu. **Show more projects** reveals the rest of a long list. Settings opens a separate page with its own section menu while keeping the icon rail available. Leaving with edits offers Save, Discard, or Keep editing.

Choose the model inside the Chat or Code message composer, beside Send. The compact menu opens on the selected thinking effort; use the slider or named stops to change it. **More models** opens the model-name list, with arrow keys, typeahead, and Enter for selection. **Use a model ID…** offers an advanced search/custom-ID entry. Escape closes the menu. Media playgrounds open directly on their model-name list. Catalog search remains available in Settings.

Chat shows an iconless **Thinking** label while the model prepares its response. Code keeps a **Working for <time>** section header above the transcript throughout the run, with a divider beneath it and no timers on individual tool messages. Current actions shimmer in a band proportional to the label width: a one-second sweep followed by a three-second rest, respecting reduced motion. Completed actions use past-tense labels and stop shimmering. Consecutive successful actions in the same category collapse into expandable groups in both live and completed history; assistant updates, different categories, active calls, and failures keep their positions and break those groups. Labels without meaningful details are plain text rather than buttons. Image generation keeps its own progress preview.

Completed activity collapses under **Thought for <time>** in Chat or **Worked for <time>** in Code. Expand it to see intermediate assistant messages and tool activity in order, with secondary tool text and normal assistant prose. Thinking labels are not retained. Raw tool arguments and results are hidden by default; enable **Settings → Personal → Appearance → Debug mode** to reveal separate **Tool details** disclosures. Final answers and generated images remain visible. Chat's duration excludes final-answer streaming; Code's duration covers the complete run. FreeLM names new conversations in the background after a successful response and preserves manual renames. The composer clears immediately on send. Code keeps the composer, model, and permission controls available while working and queues additional messages. Local saves send only changed records and message fields instead of copying historical media. Ordinary local chat requests can start while their initial save finishes; Code tasks with tools enabled and remote conversations wait for that save before starting.

Code keeps a divider beneath both its active and completed work headers. Edited-file activity counts distinct files within each group, including multi-file patches. Rejected tool approvals appear as expandable **Approval denied** messages containing the requested action and the reviewer's reason. Ordinary execution errors remain separate tool failures.

The Pinned summary panel collects conversation sources once the conversation contains user and assistant messages, even when no sources have been collected yet. Its dedicated top-bar button toggles it independently of the project/thread sidebar and remembers visibility across restarts. New conversations have no Pinned summary panel. Narrow windows keep it below the conversation rather than covering the composer.

### Code workspace tabs

Use the numbered button at the far right of Code’s titlebar to open resizable tabs beside the conversation: workspace files, Markdown/source previews, Changes review, and an integrated browser. Browser element annotations add a screenshot and comments to your draft before sending. Tabs are scoped to the selected host/project, and opening them temporarily hides the pinned summary while preserving its preference. See [Code workspace tabs](docs/CODE_WORKSPACE_SURFACE.md) for capabilities and boundaries.

### Bots

Open **Bots** below Home in the icon rail. Create a named bot with a `name@freelm` address, choose a model and thinking mode on its home computer, and describe its identity. Each bot has editable learned personality notes and switches for learning and Chat/Code thread access. Messages use a compact bubble interface with typing indicators, reactions, replies, editing, unsending, and retry for failed bot replies. Drafts and conversations persist on the owning host.

Connected FreeLM computers appear alongside local bots; the home computer is shown next to each bot to distinguish identical addresses. Use **New group** to message multiple bots, including bots on connected computers. Models and identity notes run/stay on each bot's home computer; a group's transcript is stored on the computer chosen when creating it. Bots can discover hosts/projects/models, search and read Chat/Code history, create threads, send queued follow-ups, wait for replies, rename, archive/restore, and stop tasks. New Code tasks use Ask for approval and existing tasks retain their permissions. Both ends need the updated app, with the target computer’s local workspace open. This first version responds to messages while FreeLM is running; scheduled proactive work, attachments, and the full tool catalog are future work. See [Bots architecture and boundaries](docs/BOTS.md).

### Connected plugins

Open **Settings → Integrations → Plugins** to install an independent TypeScript/JavaScript plugin from `.freelm-plugin`/`.zip`, or import a JSON manifest for an existing HTTP MCP service. Local plugins compile on installation and can add model tools and custom tabs. Connect labeled accounts and choose access per tool. OAuth uses the service's registered public client with PKCE. Accounts start with access off; grant individual tools separately to Chat, Code, selected bots, and connected remote clients. Credentials stay on the owning host in OS-backed encrypted storage. Plugin settings save immediately. See [plugin setup and permissions](docs/PLUGINS.md), the [TypeScript SDK](docs/PLUGIN_SDK.md), and the [independent Notebook example](examples/plugins/notebook/README.md).

### Model catalog and thinking modes

Under **Settings → Personal → Configuration**, add a model or click **Configure** beside any discovered ID in the model list. Set its display name, API ID, enabled state, supported playgrounds, and input/output modalities. Apply the model, then save settings. Catalog entries are per connection and persist with the workspace. Chat and Code require a configured thinking value; media models can use provider defaults for optional parameters.

Configured capabilities control model choices and reject unsupported inputs before a request is sent. For example, an image model with text input can generate images; adding image input allows reference images and edits. Disabled entries cannot be selected by manually entering their ID. Removing a catalog entry returns its ID to unconfigured behavior.

Chat and Code require a configured thinking value for the selected model and API. Open **Chat model** in the composer to choose **Thinking mode**. New chats, model selections, and older chats without a saved mode use the configured default or the first mode available for the connection's API. There is no provider-default option. The selected model and mode are saved per chat; each new response records its own model and mode. Models without a usable thinking value cannot send messages until configured in **Settings → Configuration → Models**.

The workspace-wide **Thinking values** list starts with Low, Medium, and High examples. Add a display name and API effort value, then add supported values to each model. Each addition copies the value into that model; later edits to the shared list do not change existing model settings. The simple effort editor maps values to `reasoning.effort` for Responses and `reasoning_effort` for Chat. Keep only levels supported by your model. Custom modes accept separate JSON parameter objects for the two endpoints, including provider-specific fields. Blank endpoint JSON means the mode is unavailable for that endpoint; each configured mapping must specify a concrete value. For a model that supports disabling reasoning, configure its explicit API value, such as `none` or `false`. Request content, model, routing, streaming, and tool fields cannot be overridden. See the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) for endpoint behavior.

Modality declarations describe the provider's capabilities; the conversation adapter accepts text and images. Chat and Code render configured image- and video-generation results inline; videos have playback and download controls. Direct audio/video conversation input and realtime voice need additional adapters. Speech, transcription, image, and video generation also have dedicated playgrounds. Remote workspaces use the host's catalog and thinking modes; edit the catalog on the host.

### Chat, Code, and tools

**Chat** is for conversations, with optional image generation through your configured API and web browsing through your SearXNG service. **Code** has its own tasks, projects, and history for work with commands, files, MCP tools, and skills. Chat cannot use those host tools or reference host filesystem paths. Both use the same provider catalog and model chooser. Open **Tools** in the Code composer or **Settings → Personal → Tools** to enable the agent loop, command execution, and a separately configured image-generation model. **Integrations → MCP servers** supports stdio and Streamable HTTP servers with tool discovery; **Integrations → Skills** loads `SKILL.md` packages from folders you choose. Code shows tool activity, permission prompts, questions, and generated images, and saves tool history for subsequent messages. Enable **Generate images in Chat and Code** for the image tool: Chat can use that setting independently of **Enable tools in Code**; Code requires both switches. Chat edits use uploaded or recent conversation images, while Code can also use project files. See [tool setup, supported capabilities, and execution boundaries](docs/tools.md).

To enable web browsing, open **Settings → Personal → Search**, choose **Built-in**, turn on **Browse the web in Chat and Code**, select text and image engines, and save. Click **Start** to launch the bundled SearXNG service; Docker and system Python are not needed. **Start with FreeLM** is optional. The page shows service status and recent logs, and **Stop** keeps the service stopped until you start it again. **External** retains support for your own SearXNG URL and engine discovery. Existing external configurations keep that choice. `web.run` supports text/image search, provider selection, pagination, domain/date filtering, public page/PDF reading, links, text finding, and PDF screenshots. Engine failures remain visible, and the model can cite returned source URLs. Chat uses browsing independently of the Code tools switch. Documents are read without JavaScript, browser cookies, or login credentials. See [SearXNG setup and browsing behavior](docs/tools.md#web-browsing-through-searxng).

Image tool calls show an animated placeholder during generation and the finished image directly in the conversation. Click an image to open its viewer, download the original, change zoom, or enter full screen; clicking the blurred background exits full screen. Generated images sent back to a vision model use previews bounded to a 1536-pixel long edge and 1 MiB data URL. Full-resolution originals remain in conversation history and the gallery for viewing, downloading, and editing. Existing generated-image transcripts are compacted when replayed; user-uploaded attachments retain their original fidelity.

Existing tool settings are retained. Legacy projects with bound folders move to Code, as do conversations containing tool calls or agent transcripts and conversations belonging to a Code project. Ordinary conversations remain in Chat. Explicit saved classifications are preserved; migration keeps all messages and project links.

Image models can define named quality/resolution presets, each with its own aspect ratios and pixel dimensions. Configure a model's **Image presets**, choose defaults, then Apply and Save settings. **Use recommended presets** adds editable suggestions for Qwen Image 2.1, Qwen Image 2512, Qwen Image Edit, and Krea 2 Turbo. In the image playground, choose the model in the composer and open **Image settings** for Quality and Aspect ratio. Display labels stay in FreeLM; the API receives the selected dimensions and only an explicitly configured optional API quality value. **Custom / provider settings** accepts arbitrary values or blank fields for provider defaults. See [the preset tables and their sources](docs/image-presets.md) for published versus derived sizes and provider differences.

### Supported endpoints

| Feature       | Path relative to the base URL  | Behavior                                                                                     |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Chat          | `/responses`                   | Streaming text, image inputs, full conversation replay, project instructions; `store: false` |
| Chat          | `/chat/completions` or `/chat` | Chat Completions JSON and SSE schemas, image inputs, system/project instructions             |
| Models        | `/models`                      | Discover IDs; manual IDs work without this endpoint                                          |
| Images        | `/images/generations`          | Prompt, model, size, optional quality, image count; URL and base64 results                   |
| Image edits   | `/images/edits`                | Multipart image references and optional PNG mask                                             |
| Video         | `/videos`                      | Multipart create with duration, size, optional image reference                               |
| Video status  | `/videos/{id}`                 | Poll progress, pause checking, resume saved jobs                                             |
| Video content | `/videos/{id}/content`         | Authenticated download and playback                                                          |
| Speech        | `/audio/speech`                | Voice, format, speed, optional instructions; playback and download                           |
| Transcription | `/audio/transcriptions`        | Audio upload or microphone recording, optional language/context; copy/download transcript    |

Enable **Video generation** in **Settings → Tools** and choose its API connection, video model, default resolution, and duration. Video tool requests always send an explicit size: the saved default or the existing playground default, `1280x736` (720p rounded to multiples of 32), when no size is configured. Saved custom resolutions are preserved. Explicit per-call sizes override it; blank duration still uses the provider default. Chat and Code can call `video_gen.videogen` with optional size/duration overrides and one reference image. Chat uses an attached/recent image; Code may also use an authorized workspace image path. The tool creates one provider job and waits for its terminal status without a total polling deadline. Stopping cancels FreeLM's waiting, not necessarily the provider job. This tool is called directly rather than through `functions.exec`.

**Settings → Moderation** uses a separate image-capable evaluator for videos. Input moderation jointly classifies the prompt and every attached reference image using the same strict ten-field schema and contextual rules as image edits. It evaluates the anticipated video across the requested timeline, including retained content, person presence, and implied clothing removal; sexual or nude reference-based transformations are blocked at every enabled level. Text-only video prompts retain the standard seven-field classification. Unreadable references or invalid classifier results stop the request before video generation. Output moderation decodes the generated clip locally and evaluates one frame at every whole second (starting at zero). Every sampled frame must pass before any video is released. This samples visual content only; it does not inspect audio or content between samples. Missing evaluator configuration produces a warning; a configured evaluator or decoding failure blocks release. Both tool and playground requests use this same guard. Tool video downloads and moderated video snapshots are limited to 32 MiB. Connected remote hosts must support frame-based video moderation and, for reference-based requests, contextual video-reference moderation.


The configurable `/chat` path uses the **Chat Completions schema**. Non-OpenAI request shapes and provider-specific protocols need their own adapters. Optional parameters, model capabilities, voices, and supported formats depend on your provider. A host-only base URL adds `/v1`; a path-prefixed URL preserves its prefix. Redirects are rejected: configure the final API URL so credentials are not forwarded to another destination.

Chat recognizes `response.completed` in either the Responses event type or SSE event field, and drains buffered events at EOF, including a final event without a blank-line delimiter. Invalid or incomplete UTF-8 and malformed JSON are reported explicitly. Stream failures include received character/event counts and the last event type; successful HTTP reads also supply transport byte counts. A mismatch between transport and renderer character counts reports a desktop delivery error separately from a stream with no completion event. These diagnostics are saved with the message error without including raw event bodies or API keys. EOF alone never marks a partial response complete.

Desktop stream chunks and their final result use the same ordered IPC channel. Chat waits for that final result before removing its listener; an earlier IPC request acknowledgement cannot truncate large responses. Cancellation releases the pending stream immediately, and invocation tokens keep late events from affecting later requests. A 30-second delivery watchdog starts only after the network request finishes, independently of the 30-minute API timeout.

## Workspace

- Streaming Markdown chat, image attachments, text file context, and export to Markdown. Edit any sent prompt or regenerate any answer; version arrows preserve earlier answers and their continuations. Branch a conversation from an assistant reply into a separate chat.
- Each conversation has a persistent draft, including attachments and selected-text reply references. Empty-composer Up restores the previous prompt. Large pasted text becomes a text attachment, and rich-text paste retains safe Markdown formatting. Select text in an answer and choose **Reply to selection** to attach a removable reference above the composer, separate from your typed prompt. The selected passage accompanies the request as quoted context and remains visible on the sent message.
- Chats run independently: switching conversations leaves replies running, and Stop cancels only the selected conversation. Optional completion notifications open the finished chat when clicked.
- Archive conversations from their sidebar menu and restore them in **Settings → Personal → Archived chats**. **Temporary chat** (also `Cmd/Ctrl+Shift+N` in Chat) stays out of saved history, drafts, workspace exports, and memory; configured Chat tools remain available. Providers may still receive the conversation as normal API requests.
- Configure an ASR connection and transcription model in **Settings → Personal → Chat** before enabling dictation. The microphone beside Send opens a recording toolbar with a live microphone waveform. Stop inserts the transcription at your cursor for review; Send transcribes and sends the current draft and attachments. Cancel discards the recording. If dictation is not configured, the microphone offers a setup notice with a link to Chat settings. Chat and Code composers format Markdown in place: typing three backticks opens an editable code block, and completed `$...$` / `$$...$$` equations render directly in the editor. Click an equation to edit its source. Enter adds a line inside code or display math; Shift-Enter adds a line anywhere, and Command-Enter / Ctrl-Enter sends. Drafts and requests preserve the original Markdown, including indentation. Sent code blocks have syntax highlighting, a language label, and Copy.
- Web browsing presents compact source lists and linked citations. Image searches use text activity messages without automatic thumbnail previews. Models can inspect chosen results using `image.view` without receiving every image. Enable isolated **Chat Python** in **Settings → Personal → Tools** for persistent Python variables, text output, images, and downloadable files; see [execution limits](docs/tools.md).
- Chat and Code keep separate histories, search results, and projects. Search titles and messages; rename, pin, delete, and move conversations into projects of the same kind.
- Create or edit a Code project to bind one or more folders. The first folder is the default working directory; command working directories and file tools can use any listed folder. Code tasks outside a project use **Default working directory** in **Settings → Personal → Tools**. Chat projects carry instructions without filesystem bindings. Folder selection does not enable execution or change approval settings. See [project folders and execution](docs/tools.md#project-folders-and-execution).
- **Settings → Personal → System** configures a workspace system prompt. Chat and Code requests include this prompt followed by any project instructions; both Responses and Chat Completions use the combined instructions.
- Settings is a full page. **Personal** groups Configuration, System, Appearance, Connections, and Tools; **Integrations** contains Remote FreeLM, MCP servers, and Skills. Switching options preserves edits. Save settings before leaving, or explicitly discard changes.
- Persistent media history, previews, downloads, and resumable video status checks.
- Images opens a masonry gallery with equal-width tiles and natural image heights. The compact composer includes attachments, a compact model chooser, and optional size, quality, and count settings.
- Open an image for a full-window view with zoom, download, its original prompt, and direct editing. Edits create a new result while keeping the original. Remove background prepares an edit prompt; Erase sends a PNG mask for the selected rectangle; Resize sends the requested dimensions. Model support determines the resulting transparency, mask behavior, and accepted sizes.
- The video playground uses the same composer and equal-width masonry gallery, with a compact model chooser, reference image, duration, and resolution settings. Custom width and height snap to the nearest positive multiple of 32 when you leave the size field, press Enter, or submit; halfway values round up. Accepted prompts clear immediately. Open a video for playback, download, and prompt reuse; expand or double-click the video for a blurred full-screen view. Click the surrounding blur or press Escape to return. Saved jobs can resume after a pause or a temporary status/download failure without starting another generation.
- Dark, light, and system appearance. **Settings → Appearance → Accent color** offers color presets and a custom hex color for your message bubbles and primary buttons, with a preview and readable text contrast. `Cmd/Ctrl+N` starts a conversation in the active Chat or Code workspace; `Cmd/Ctrl+K` searches that workspace.
- Workspace export contains history and settings without API keys.

## Connect another FreeLM instance

Open **Settings → Integrations → Remote FreeLM**, or use **Manage instances** near the bottom of the icon rail. A connection opens the other machine's workspace: its chats, Code tasks, projects, media history, and configured API connections. Requests execute on that machine. Switching back to **This Mac / This computer** restores your separate local workspace.

1. On the host computer, open **Remote FreeLM**, choose a sharing name and host port (default `4319`), then **Start sharing**. Keep FreeLM running.
2. Configure SSH key access to that computer, using an SSH alias in `~/.ssh/config` or `user@hostname`. Verify its host key and successful key authentication in your terminal first. FreeLM uses system SSH, requires an already trusted host, and does not prompt for SSH passwords.
3. On the client computer, open **Remote FreeLM → Add instance**, choose **SSH**, and enter the host, the **FreeLM host port**, and the access token shown on the host. SSH ports, jump hosts, usernames, and identity files can be configured in your SSH config.
4. Choose **Connect and open**. The workspace name appears above the content. Use the host's provider connections in Chat, Code, and the media playgrounds.

The host listens only on `127.0.0.1`. FreeLM starts and manages a local SSH tunnel. **Direct URL** also supports an existing loopback tunnel or an HTTPS reverse proxy you control. For a reverse proxy, forward to `http://127.0.0.1:4319`, rewrite the upstream `Host` header to `127.0.0.1:4319`, preserve `Authorization`, disable streaming response buffering, and allow sufficiently long request timeouts and large media bodies. The protocol rejects redirects, browser `Origin` requests, and non-loopback upstream host headers. Never expose it over public plain HTTP.

Provider API keys stay on the host; remote provider settings are read-only. Saved instance access tokens use the OS secret store or remain in memory when secure storage is unavailable. Sharing is off at app startup; starting sharing creates a fresh token. **Stop sharing** invalidates that token and aborts active remote requests. After restarting sharing, edit the saved connection to enter the new token. Closing the last macOS window keeps sharing active; quitting FreeLM stops it. On Linux, closing the last window quits the app.

**Refresh** loads edits made by another client. Saves check workspace revisions: conflicting edits are rejected instead of overwriting newer work. **Reload latest** writes a key-free backup of your unsaved view to the client’s FreeLM home `recovery` folder before loading the current host copy. The app displays the backup path. If the backup cannot be saved, it keeps your unsaved view. You can also back up and switch to your local workspace if the host becomes unavailable. Small backups are standalone JSON exports. Large backups include a companion `.json.media/` folder; keep both together. This prototype does not yet offer a merge/import UI.

This is remote workspace access, not synchronization: remote history stays on the host, and the client does not make a local workspace copy. Switching cancels active requests and recording. Generated remote image URLs are fetched on the host and returned as embedded image data (32 MB per image), so host-local media URLs can display on the client. Older URL-based images in host history are also fetched through the host when opened, without changing the saved record. Other media uses the same host API transport. Downloads you explicitly save remain on the client.

The client must remain connected while a request runs; jobs are not yet managed by a durable background worker. Video status checks can be resumed from their saved job IDs. Code tools and Chat image generation use the host boundary when the host explicitly enables remote tools; configuration and approval policy stay on the host. Both computers must support the Chat/Code boundary for tool discovery and execution; older hosts still support ordinary chat and media playground requests. Computer use is not implemented yet. Current validation uses local fixture providers and Electron instances; physical cross-machine SSH, production HTTPS proxies, and Linux desktop execution remain release-validation work.

## Data and credentials

The desktop app keeps its persistent data in `~/.freelm` by default. Settings displays the actual storage location. The home contains:

| Path             | Contents                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `config.json`    | Application settings, provider connections, model configuration, and tool configuration.                |
| `workspace.json` | Conversations, projects, and media history, with references to large embedded media stored in `media/`. |
| `media/`         | Private, content-addressed large media and transcript strings referenced by `workspace.json`.           |
| `instances.json` | Saved remote FreeLM connections.                                                                        |
| `skills/`        | Created for local skill packages; add it under **Settings → Integrations → Skills** to use it.          |
| `search/`        | Generated SearXNG settings, private service secret, cache, temporary files, and bounded logs.           |
| `recovery/`      | Key-free backups made when recovering unsaved remote-workspace edits.                                   |

Set `FREELM_HOME` to an absolute path or a path beginning with `~/` to use another directory. This override also works in packaged builds; set it in the environment used to launch FreeLM. For example, `FREELM_HOME=/absolute/path/to/freelm npm start` uses that home for a production build launched from this checkout. An explicitly selected home starts independently and does not automatically import the default profile. The development-only `FREELM_USER_DATA` override takes precedence when supplied, keeping test homes and Electron profiles isolated.

When adopting the default `~/.freelm` home, FreeLM automatically migrates existing data from its previous Electron user-data location. It stages the copy, verifies checksums, and preserves the original files. Migration can resume after an interruption and does not overwrite existing destination data. Existing configured skill folders keep their paths.

Writes are serialized, individual files are replaced atomically, and a temporary `workspace.json.pending` journal allows interrupted configuration/workspace saves to recover. Media-heavy workspaces are encoded and written in bounded chunks, avoiding a whole-workspace string or UTF-8 buffer during saves. Fully quit FreeLM before manually editing or copying its persistent files so that in-memory changes cannot overwrite your edits and backups capture a consistent state.

Desktop workspace loads, saves, patches, and recovery copies also use bounded transfers across IPC and the isolated preload bridge. Repeated large strings are transferred once and reused through private renderer-scoped handles; individual chunks are at most 128 KiB of text. The renderer reconstructs the workspace after the bridge, avoiding a single serialized message containing the entire media history. `npm run test:workspace-transfer` checks real desktop startup and round trips with a media history exceeding 512 MiB in an isolated test home.

API keys and saved instance access tokens are encrypted using Electron `safeStorage` when secure storage is available. Their ciphertext depends on the host's OS credential store and is not portable to another machine; copying the FreeLM home alone is not a credential-transfer method. With insecure Linux `basic_text` or an unavailable secret store, newly entered secrets stay in memory only.

If a copied home cannot unlock credentials on another machine, quit FreeLM and keep an untouched backup. In the **destination copy only**, set `encryptedKeys` in `config.json` to `{}` and remove the `encryptedToken` fields from the remote profiles in `instances.json`. Leave the remaining configuration and history intact, relaunch FreeLM, and enter API keys and remote access tokens again through Settings.

By default, Chromium session and cache data live in `~/Library/Caches/FreeLM` on macOS and `$XDG_CACHE_HOME/FreeLM` (or `~/.cache/FreeLM`) on Linux. An explicit home override keeps that data in `<home>/.cache` for isolation. `FREELM_HOME` leaves Electron machine metadata in its platform user-data directory (normally `~/Library/Application Support/FreeLM` on macOS and `~/.config/FreeLM` on Linux); the development-only `FREELM_USER_DATA` override also relocates that profile. Migration leaves old cache files in place with the original data. Browser preview uses IndexedDB and keeps keys only in memory.

Requests send your prompts and uploaded content directly to the configured provider. FreeLM adds no analytics or hosted backend. Chat uses full history replay, so it also works with stateless compatible servers.

Base64 image results and downloaded speech/video bytes are part of the workspace; the desktop store keeps large embedded strings in `media/`, while browser preview uses IndexedDB. **Provider-hosted image URLs remain URLs and may expire**; download those results while they are available. The transport limits each media response to 256 MB and each chat stream to 16 MB. Individual desktop requests time out after 30 minutes, with HTTP header and body waits configured for the same cold-start window. Video polling has no total duration cap, so jobs can run for hours until the provider reports completion or failure. Checking still pauses on a request error, manual pause, or leaving the Videos playground, API connection, workspace, or app; saved job IDs can be resumed without another generation. Stopping a request or pausing polling does not guarantee that the provider cancels remote work or billing.

Deleting a chat or generation removes its local record. Removing a project keeps its chats and moves them out of the project. Connections with saved chats or media cannot be removed until those records are deleted. Microphone recording needs OS permission.

## Build desktop packages

```bash
# macOS: release/mac-universal/FreeLM.app
npm run package:mac

# Linux: run on a Linux host with packaging prerequisites
npm run package:linux
```

macOS packaging uses an installed signing certificate for local development and fails if no identity is available. Apple notes that [local-network privacy needs an Apple-issued signing identity to reliably track an app](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy). Use a persistent Apple Development certificate when testing against LAN servers. If you have several identities, select the intended certificate without adding personal names to project configuration:

```bash
CSC_NAME="Your certificate name" npm run package:mac
codesign --verify --deep --strict release/mac-universal/FreeLM.app
```

Use the certificate name without its `Apple Development:` prefix. The default build preserves Electron's hardened runtime and disables notarization for local development. Development signing is for local use; public distribution still needs a Developer ID signing and notarization workflow.

If you do not have a signing certificate, you can explicitly build an ad-hoc-signed prototype:

```bash
npm run package:mac -- --config.mac.identity=-
```

Ad-hoc signing does not provide the stable Apple-issued identity needed for reliable local-network privacy attribution. LAN access or other macOS permissions can fail or need to be granted again after rebuilding. Keep a fixed installation path, and do not replace the designated requirement with an identifier-only rule. This fallback is never selected automatically.

macOS packaging builds a universal app for Apple Silicon and Intel. This keeps the desktop runtime native even when the Node.js build toolchain itself runs under Rosetta. The bundle is written to `release/mac-universal/FreeLM.app`. For an architecture-specific build, use `npm run build` followed by `npx electron-builder --mac --dir --arm64` or `--x64`. Linux targets are AppImage and Debian packages. Build on the target OS for release validation; macOS signing/notarization and Linux distribution testing are separate release tasks. These are local development builds, not notarized distributions.

Before macOS packaging, `scripts/prepare-mac-dependencies.mjs` ensures both Canvas native addons are present for PDF screenshots. It stages only missing or mismatched addons from official npm archives whose versions and integrity match the installed Canvas package and `package-lock.json`; it does not reinstall or prune other dependencies. Run this preparation script before a manual architecture-specific build as well.

Packaging also runs `scripts/prepare-search-runtime.mjs`, which verifies and stages pinned SearXNG source, a standalone Python interpreter, dependencies, and third-party notices from official upstream archives. macOS includes both native runtime architectures; Linux preparation selects the build host's architecture. For development, run `node scripts/prepare-search-runtime.mjs --targets=darwin-arm64,darwin-x64` on macOS, or the script without arguments on Linux, before using built-in search. These downloads happen during preparation, never when the app starts. See [the bundled service details](docs/tools.md#bundled-search-service).

On macOS, `scripts/package-search-resources.mjs` copies the verified search resources after universal merging and before signing. This avoids scanning the same Python/source trees twice. Standalone architecture builds include their matching runtime. Build universal and standalone Mac targets in separate commands.

Source, notices, and Babel locale data are covered by the app's resource seal without individual binary signatures. Native interpreters and libraries remain individually signed.

## Validation

After a fresh checkout, prepare the bundled search dependencies before running the full test suite: `node scripts/prepare-search-runtime.mjs --targets=darwin-arm64,darwin-x64` on macOS, or `node scripts/prepare-search-runtime.mjs` on Linux. The macOS tests exercise both runtime architectures.

```bash
npm test                    # API, SSE, multipart, persistence, IPC validation
npm run build              # strict TypeScript + renderer + desktop bundle
npm run test:e2e            # real UI with an explicitly mocked compatible API
node scripts/smoke-desktop.mjs  # real Electron, isolated temporary profile/local mock server
npm run test:instances       # two real Electron instances, remote UI and conflict/offline recovery
npm run test:tools           # isolated Code task with commands, approvals, questions, and images
npm run test:chat-images     # isolated Chat image generation, large gallery saves, and restart recovery
npm run test:web             # isolated Chat browsing with mock search/model APIs
npm run test:search          # real bundled service, live search, lifecycle/restart; no model API
npm run test:context-menu    # native editor context actions and clipboard behavior
```

If Playwright Chromium is not installed, run `npx playwright install chromium` before browser tests. Tests make no paid requests and do not access real credentials. `test:search` sends public queries to real search engines; their availability can vary. Native smoke requires a graphical desktop. End-to-end tests cover contract behavior; they are not proof that a particular provider/model supports an endpoint. Connect your server for real-model qualification.

## Project structure

```text
src/App.tsx                 Workspace state and navigation
src/components/            Chat/Code conversations, sidebar, settings, media playgrounds
src/lib/api.ts              Compatible API adapters and SSE parser
src/lib/catalog.ts          Model capabilities and thinking parameter validation
src/lib/storage.ts          Desktop/browser persistence boundary
src/types.ts                Shared workspace and IPC contracts
electron/main.ts            Sandboxed window, menus, IPC, credentials
electron/transport.ts       Main-process HTTP and streaming
electron/state-store.ts     Split persistence and encrypted credentials
electron/storage-paths.ts   Persistent home, legacy profile, and cache paths
electron/storage-migration.ts Verified migration that preserves legacy files
electron/workspace-authority.ts Revision checks shared by local and remote writers
electron/instance-host.ts   Authenticated loopback workspace and execution service
electron/instance-client.ts Remote protocol and SSH tunnel lifecycle
electron/instance-manager.ts Saved hosts, secure tokens, hosting lifecycle
electron/validation.ts      Boundary validation
scripts/                    Desktop build, launch, native smoke
tests/                      Unit and UI contract tests
```

Computer use, realtime voice conversations, and full ChatGPT/Codex feature parity remain outside this prototype. Command execution, MCP tools, skills, and configurable image generation from Chat and Code are covered by the [tool runtime](docs/tools.md).

The [Codex CLI tool inventory](docs/codex-tool-inventory.md) records the source-verified tool catalog, optional integrations, and FreeLM's current gaps for the next implementation step.

Protocol references: [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [Images](https://developers.openai.com/api/reference/resources/images), [Videos](https://developers.openai.com/api/reference/resources/videos), [Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create), [Transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), and [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
