# FreeLM Plugin SDK (API v1 and v2)

Plugins are independent TypeScript/JavaScript packages. FreeLM installs and compiles source locally; publishing or updating a plugin does not require rebuilding the app. The same package format can later be distributed by freelm.ai.

API v1 supports model tools, custom workspace tabs, per-account JSON storage, and host-brokered HTTP requests. API v2 adds general Chat/Code surface extensions, composer/drawer APIs, conversation context, inference, and native plugin settings. Remote MCP manifests remain supported. Gmail is not built into this framework: a Gmail package can implement its API operations using the same SDK and host-managed OAuth as another integration.

## Package and install

A `.freelm-plugin` file is a ZIP archive; `.zip` is accepted too. Put `manifest.json` at the archive root alongside source files and assets:

```text
manifest.json
src/index.ts
src/tab.ts
src/tab.css
README.md
LICENSE
```

Use `node scripts/package-plugin.mjs examples/plugins/notebook /tmp/notebook.freelm-plugin` to package the working example. Open **Settings → Plugins → Install plugin**, choose the archive, review its capabilities, and install. The compiler is included in FreeLM, so users do not need Node, TypeScript, npm, or a cloud build service. Installation never runs package scripts or downloads dependencies.

TypeScript compilation strips types and bundles modules; it is not a type checker. Plugin authors should typecheck their source during development. Package-relative modules and the virtual SDK imports are supported. Bundle third-party dependencies into your source before distributing; automatic npm dependency installation and native modules are not supported. TSX uses classic JSX with an author-provided JSX factory, rather than supplying React implicitly.

Compilation finishes before the installed registry is changed. A compilation failure keeps the previous version. Updates reset assistant tool grants; changes to authorization or capability identity may require reconnecting. Disabling/removing/updating a plugin invalidates pending calls and removes outdated UI contributions.

## Manifest

See the complete [Notebook manifest](../examples/plugins/notebook/manifest.json). A local manifest uses `manifestVersion: 2` and these fields:

| Field                                                                 | Purpose                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`, `name`, `version`, `description`, optional `author`, `homepage` | Package identity and user-facing review                                                     |
| `runtime: { apiVersion: 1\|2, entry: "src/index.ts" }`                | Host-side JavaScript entry                                                                  |
| `permissions.network`                                                 | Exact allowed origins, e.g. `https://gmail.googleapis.com`; no wildcards                    |
| `permissions.storage`                                                 | Access to this plugin account's JSON data                                                   |
| `contributes.tools`                                                   | Model tool names, descriptions, object JSON schemas, and informational `readOnly` hints     |
| `contributes.tabs`                                                    | Tab IDs, titles, JS/TS entry points, optional icon (`puzzle`, `mail`, `notebook`, `layout`) |
| `contributes.actions`                                                 | Functions the plugin's own tabs can invoke                                                  |
| `auth`                                                                | `none` or host-managed OAuth 2 authorization code with PKCE                                 |

HTTPS is required, except for explicit literal loopback HTTP origins for development. Review/installation grants the declared capabilities to the plugin's human-facing UI; model-invoked tools additionally require account, tool, and Chat/Code/Bot grants. API v2 text inference uses the separate capability and model-setting grants below. A read-only annotation is a description, not an enforced guarantee.

## Runtime API

Import `definePlugin` and types from `@freelm/plugin-sdk`. Its type definitions are in [packages/plugin-sdk/index.ts](../packages/plugin-sdk/index.ts).

```ts
import { definePlugin } from '@freelm/plugin-sdk';

export default definePlugin({
	tools: {
		read_note: async (_args, context) => ({
			text: (await context.storage.get('note')) ?? '',
		}),
	},
	actions: {
		read_note: async (_args, context) => ({
			text: (await context.storage.get('note')) ?? '',
		}),
		save_note: async (args, context) => {
			if (typeof args.text !== 'string') throw new Error('Expected text.');
			await context.storage.set('note', args.text);
			return { saved: true };
		},
	},
});
```

Handlers receive JSON arguments and a context:

- `account.id`, `account.label`: the host-selected account; no credentials.
- `storage.get(key)`: a JSON value, or `null` when absent.
- `storage.set(key, value)`, `storage.remove(key)`: persistent account-scoped JSON storage.
- `fetch(url, options)`: an HTTP response `{ status, headers, body }` with a text body. Parse JSON explicitly. The host enforces the manifest's origins, response/request bounds, cancellation, and redirects policy.

Tool declarations can specify `execution: "sync" | "async"`, `effect: "read" | "write" | "external" | "destructive" | "unknown"`, and `requiresApproval`. Execution defaults to async, including remote MCP/network tools. Use sync only for a quick, bounded lookup; sync describes scheduling in the Bot runner, not a JavaScript return type. Both kinds may return a Promise. `effect` must agree with `readOnly`; these declarations are reviewed hints and cannot grant access or authorize an action. MCP tools may opt into quick execution with `_meta["freelm/execution"]: "sync"`.

For Bot callers, non-read-only tools require a host-approved action in addition to the existing plugin/account/tool grant. The host can provide an authorization hook, and rechecks grants after approval. Read-only calls do not add a per-call prompt unless the declaration explicitly requests it. Existing Chat/Code approval policies remain separate.

Tool handlers receive an optional `context.operationId`, generated by the host and preserved with durable Bot actions. Remote MCP calls receive the same identity as `_meta["freelm/operationId"]`. A plugin can use it with its provider's idempotency or reconciliation mechanism. The identity alone does **not** guarantee exactly-once effects; if a request may have completed before losing its response, verify the external outcome before retrying. The host does not invent HTTP idempotency headers for arbitrary providers.

Validate tool/action arguments in your handler; declared tool schemas inform model requests and do not replace runtime input validation. Results must be JSON serializable. Model tool results are returned as text containing that JSON. Plugins cannot start independent long-lived processes or scheduling loops. FreeLM may run a tool invocation as a host-owned background job, but each invocation still gets a fresh WASM JavaScript context. Use storage for persistence.

The guest has no Node APIs, filesystem, shell, Electron, direct network, or credentials. A worker runs a memory/CPU-bounded QuickJS WASM context; plugin source is never evaluated by Node. A separate worker compiles source so installation does not block the renderer.

## Custom tabs

Tab entries own their DOM inside a sandboxed view, rather than injecting components into FreeLM's React tree. Import `invoke` from `@freelm/plugin-ui` to call an action:

```ts
import { invoke } from '@freelm/plugin-ui';
const note = await invoke('read_note', {});
await invoke('save_note', { text: 'A note from my tab' });
```

Import local CSS normally. FreeLM passes a light/dark theme and selects the account outside the plugin frame. Each view has an opaque origin, a per-view message channel, and a restrictive content policy. Requests are checked against the active frame, plugin, account, and declared actions. Tabs cannot access FreeLM state, its desktop bridge, another plugin, or another account by supplying IDs. Native desktop navigation guards prevent frame navigation to external pages.

Desktop views load from single-use host-issued documents with sandbox restrictions in both the iframe and response policy. A `Connection-Allowlist: ()` response blocks direct connections, including WebRTC, in the bundled Chromium 152 runtime. Network operations go through SDK actions and the host's declared-origin checks.

Primary UI labels/buttons should be at least 13px. Use `color-scheme` and semantic system colors for light/dark support, as the Notebook example does. Surface extensions use the separately versioned API v2 described below; API v1 tabs do not implicitly acquire those services.

## API v2: general surface extensions

Implemented in the source tree on October 16, 2026. Use `runtime.apiVersion: 2`; existing API v1 packages keep their account-bound tools/actions behavior. Packaging and running-app verification are separate from the API contract documented here.

API v2 provides general primitives. Follow-up prompts, selected-text transformations, and drawer attachments are independent packages using the same methods; the host does not contain a suggestion-specific extension point. Public types are in [plugin-sdk](../packages/plugin-sdk/index.ts) and [plugin-ui](../packages/plugin-ui/index.ts).

### Manifest, installation, and settings

A surface-only package can use `auth: { type: 'none' }` and omit tools, tabs, and actions. No fake connected account is needed. Declare the activation surfaces, capabilities, optional native settings, and custom view entries:

```json
{
	"manifestVersion": 2,
	"id": "example.composer-extension",
	"name": "Composer extension",
	"version": "1.0.0",
	"description": "Adds a report to the composer drawer.",
	"runtime": { "apiVersion": 2, "entry": "src/index.ts" },
	"auth": { "type": "none" },
	"permissions": {
		"network": [],
		"storage": false,
		"capabilities": ["composer.drawer", "composer.attachments", "assets.create", "commands"]
	},
	"contributes": {
		"activation": { "surfaces": ["home.chat", "home.code"] },
		"settings": [
			{
				"id": "report",
				"type": "text",
				"multiline": true,
				"label": "Report content",
				"maxLength": 8000,
				"default": "A prepared report."
			}
		]
	}
}
```

Install a ZIP through Settings → Plugins, review capabilities, then enable the plugin. Chat and Code access can be switched independently. Review grants apply to the declared package version; disabling, removing, or updating the extension cancels its surface sessions. Existing account tool grants remain separate.

`contributes.settings` renders native grouped settings rows with immediate persistence. Supported types are `toggle`, `text` (optional `multiline` and `maxLength`), `number` (required `min`, `max`, optional `step`), `enum` (`options: [{value,label}]`), and `model`. Every field has an `id`, `label`, `default`, and optional `description`. IDs must be unique. The host validates defaults and saved values; undeclared values are rejected. Defaults fill newly added settings. Settings belong to the plugin installation, not an external account, and are not secret storage. Changing settings currently restarts the affected surface activations so pending work and captured settings cannot remain stale.

A model setting uses `{source:'conversation'}` or `{source:'configured',hostId,connectionId,modelId,thinkingModeId}`. The native picker currently lists the settings host's configured Chat models and explicit thinking modes. It does not yet provide a cross-host model browser. Saved unavailable selections remain visibly unavailable; they never silently fall back to another provider. `Same as conversation` captures the active conversation's full model binding.

### Activation and public services

```ts
import { definePlugin } from '@freelm/plugin-sdk';

export default definePlugin({
	async activate(context) {
		const attach = context.commands.register({
			id: 'attach-report',
			title: 'Attach report',
			async run(invocation) {
				const { values } = await context.settings.get<{ report: string }>();
				const asset = await context.assets.create({
					name: 'report.txt',
					mimeType: 'text/plain',
					text: values.report,
				});
				await context.composer.attachments.add(asset, {
					expectedRevision: invocation.composerRevision,
				});
			},
		});
		await attach.ready;
		const item = context.composer.drawer.addItem({
			id: 'report',
			title: 'Prepared report',
			icon: 'file-text',
			actions: [{ title: 'Attach', command: attach.id }],
			dismissible: true,
		});
		await item.ready;
		return () => {
			item.dispose();
			attach.dispose();
		};
	},
});
```

| Service                        | Methods                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `context`                      | Captured `surface: {kind:'home',mode:'chat'\|'code'}`, workspace/composer/thread/model identifiers, `signal`, and `reportError(message)` |
| `context.events`               | `on(name, callback)` for supported lifecycle events                                                                                      |
| `context.conversation`         | `getTurns({limit})`, `onDidCompleteTurn`, `onDidChange`                                                                                  |
| `context.inference`            | `generateText({model,system,messages,maxOutputTokens?,snapshotId?,signal?})`                                                             |
| `context.settings`             | `get()` → `{revision,values}`                                                                                                            |
| `context.composer`             | `getState`, `readDraft`, `getSelection`, `onDidChange`, `applyEdit`, `setText`, `insertText`, `setPlaceholder`                           |
| `context.composer.drawer`      | `addItem`, `addView`                                                                                                                     |
| `context.composer.attachments` | `add`, `remove`, `read`                                                                                                                  |
| `context.assets`               | `create({name,mimeType,text?\|base64?})`                                                                                                 |
| `context.commands`             | `register({id,title,action?\|run?})`                                                                                                     |
| `context.keybindings`          | `register({id?,key,command,when?})`                                                                                                      |

Each activation has a persistent isolated QuickJS session scoped to its visible composer. Ordinary draft edits emit events and preserve the session; hiding or changing its binding disposes it. Disposables have an `id`, `ready` promise, and `dispose()`; presentation handles also support `update(patch)`. Await `ready` before depending on a registration. The host cleans up even if guest code fails. Async activation does not prevent lifecycle events from cancelling initial work.

Callbacks remain in the isolated runtime. Only JSON envelopes and opaque handles cross the bridge. Packaged Electron measures CPU per worker thread, with a 200 ms synchronous execution budget, 2 seconds of aggregate execution per 10 seconds, and a separate 5-second wall-time guard. Waiting on inference does not consume these execution budgets. Memory, registrations, queued events, and concurrent operations remain bounded. Sessions are not a persistent background scheduler. `context.signal` and the guest `AbortController` support cancellation; stopping transport does not guarantee that every backend immediately stops computation. `reportError` records a plugin diagnostic without failing the conversation.

### Composer and drawer ownership

`getState()` exposes state flags and a synchronous draft `revision`, without text or attachment contents. `readDraft()` and `getSelection()` require draft-read access. `applyEdit({expectedRevision,changes,selection?})` applies text ranges as one native editor transaction; `setText` and `insertText` are conveniences. Text edits preserve Undo, selection, and draft persistence and reject stale revisions. None submits or queues a user message.

`setPlaceholder(text,{id?,expectedRevision?,acceptCommand?,hint?})` creates owned presentation text outside the document, saved draft, and model input. A command can contain a declarative `{type:'composer.setText',text,expectedRevision}` action, allowing native acceptance without a worker round trip. Keybindings reference registered commands and use validated conditions (`composerFocused`, `composerEmpty`, `contributionVisible`). Native completions and IME retain precedence. Placeholder conflicts are deterministically ordered; disposing one owner's contribution does not clear another's. User-configurable shortcut remapping/provider preference controls remain future work.

`drawer.addItem` renders a native title/description/icon/progress/actions row. Independent plugin rows stack alongside native goals and queued messages. They persist while typing unless the plugin disposes them. A drawer row is UI only: it does not attach its content to the next message. `assets.create` returns an opaque owned resource; `attachments.add(asset,{expectedRevision})` explicitly adds it through the native pipeline. Adding or removing an attachment advances the draft revision. Accepted draft text and attachments survive plugin disposal.

Current limits include 200,000 draft characters, 2,000 placeholder characters, 16 transient created assets per activation, and 500 KiB per asset. Native attachment type/model checks still apply. Filesystem paths are not asset permissions. Reading existing draft attachment bytes requires a separate capability. Assets and drawer UI are not automatically transferred to other hosts. Combined atomic text-and-attachment transactions and asset file pickers are not yet exposed.

Custom drawer views declare `contributes.views: [{id,entry}]` and mount with `drawer.addView({id,view,title?,props?,height?})`. They use sandboxed bundled HTML/JS, a light/dark theme, bounded layout, and the owning activation's grants. Import `call`, `runCommand`, `getViewProps`, and `onViewPropsChanged` from `@freelm/plugin-ui`; API v1 tabs continue using `invoke`. Views cannot inject app-global CSS or access parent DOM, Electron, or credentials. Prefer native drawer rows when custom controls are unnecessary.

### Conversation context and inference

`conversation.getTurns({limit})` requests 1–20 completed exchanges from the active selected branch. Each exchange contains visible user messages and final assistant text. Hidden reasoning, tool transcripts, system prompts, memories, inactive response versions, and attachment bytes are excluded. Snapshots are chronological and bounded to 64,000 text characters total and 16,000 per message, with truncation/omission metadata. Currently streaming replies, failed/interrupted exchanges, and temporary chats are excluded. Surface extensions are inactive in temporary chats. Snapshot IDs belong to the current session and can bind inference to an authorized read; no API v2 capability implicitly grants search through all threads.

`inference.generateText` accepts the plugin's own messages/system prompt and returns final text, sanitized model metadata, and provider usage when available. It uses the configured Responses or Chat transport with an explicit thinking mode. It does not run `App.runChat`, invoke tools, append history, generate titles, load memories, or inherit the app personality prompt. Credentials remain on the connection host.

A configured model must match a model selection approved in that plugin's settings. Routing binds to the captured host/connection before dispatch. Remote inference depends on the remote host's available transport; unsupported or unavailable routes fail rather than silently using a local connection. Automatic plugin inference is bounded and yields admission to foreground work. Use an adequate output budget for reasoning models: a short desired visible reply can still require many reasoning tokens.

### Capabilities and trust

| Capability                  | Access                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `conversation.read`         | Scoped visible conversation text and conversation lifecycle events        |
| `inference.text`            | Brokered text inference with the conversation model or configured setting |
| `composer.state`            | Empty/editable/revision/status flags and composer lifecycle events        |
| `composer.presentation`     | Owned placeholders and hints                                              |
| `composer.read`             | Draft text and selection                                                  |
| `composer.write`            | Revision-checked draft text edits                                         |
| `composer.attachments`      | Add/remove outgoing draft attachments                                     |
| `composer.attachments.read` | Read current draft attachment contents                                    |
| `composer.drawer`           | Native drawer rows and declared custom drawer views                       |
| `assets.create`             | Bounded plugin-produced assets                                            |
| `commands`                  | Named commands                                                            |
| `shortcuts`                 | Contextual keybindings                                                    |

Installing and enabling a reviewed package grants ongoing use of its declared capabilities on enabled surfaces, without a prompt for every inference or edit. A UI-only plugin need not request conversation or inference access and can activate before a model is configured. Brokered inference does not require general network access. A plugin authorized to read text and send it to a model has that access; isolation cannot undo the access the user deliberately granted. Marketplace publisher review/signing remains a separate future distribution layer.

### Independent examples and validation

- [Follow-up Prompts](../examples/plugins/follow-up): recent exchanges, configurable model/instructions, placeholder, Tab/click acceptance, Escape/type-to-dismiss, cancellation. Default model: Same as conversation; default exchange count: 3; default output budget: 8,192 tokens.
- [Selected Text Tools](../examples/plugins/rewrite-selection): a drawer command applies an uppercase transformation to selected text in a nonempty draft, preserving Undo.
- [Attachment Drawer](../examples/plugins/attachment-drawer): a native interactive drawer row creates and attaches report text without conversation or inference access.

Build each with `npm run plugin:pack -- examples/plugins/<name> /tmp/<name>.freelm-plugin`. These packages use public APIs only. Manifest/settings tests cover version gates, bounds, and capability declarations; isolated real-QuickJS tests cover activation, cancellation, event handling, and all three example flows. Browser tests cover settings and composer integration.

On October 16, 2026, the universal signed macOS app passed the native surface smoke test using a disposable profile and local model HTTP fixture: ZIP review/installation/compilation, actual QuickJS execution and inference transport, Chat/Code placeholder acceptance and Undo, new-turn refresh, cancellation after typing or switching threads, independent drawer/attachment/selection contributions, isolated custom views, disable cleanup, and light/dark/narrow layouts. No plugin runtime errors occurred. The focused suite passed 161 tests; the Electron CPU regression separately confirmed that worker suspension is not charged as CPU while runaway code still terminates. This validates the packaged pipeline, not response quality from a real model. Real-provider, remote-host, and Linux-package acceptance remain separate checks.

Workflows, arbitrary application menus, sending messages, full-history search, durable background execution, cross-host model browsing, and custom settings panels remain separate extensions to this API.

## OAuth and HTTP

A local OAuth declaration includes `apiOrigin` matching one declared network origin. `resource` is optional for providers that do not use OAuth resource indicators. Other fields match remote plugin OAuth: `clientId`, `authorizationUrl`, `tokenUrl`, optional `revocationUrl`, and `scopes`.

```ts
const response = await context.fetch(
	'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10',
	{ authenticated: true },
);
if (response.status !== 200) throw new Error(`Request failed (${response.status}).`);
return JSON.parse(response.body);
```

The host injects the account's token only for its declared authenticated origin. The plugin cannot read the token or set authorization/cookie headers. Sign-in uses the system browser, PKCE, and a loopback callback. Tokens stay encrypted on the owning host. A distributed package contains a public client ID, never a confidential client secret. This generic flow does not establish provider-specific compatibility; Gmail still needs its own package and real provider validation.

## Storage and limits

Installed packages and the registry live under `~/.freelm/plugins` (or `FREELM_HOME/plugins`). Compiled versions are identified by hashes of the source archive and compiler version; the registry points at a complete installed package. Keep the source archive for redistribution or further development. Storage is account-scoped in the local registry and is not a secret vault. Only OAuth credentials use the encrypted credential broker.

ZIP imports reject unsafe paths, symlinks, duplicate entries, unsupported archive features, and oversized/decompression-bomb data. Builds accept only in-package imports and the SDK. Runtime limits bound CPU, memory, wall time, concurrent calls, payloads, storage, and requests; see the implementation constants for exact values.

## Verification

The example exercises install-time compilation, a custom tab, account storage shared between UI and model tools, updates, and disabling/removal. Automated checks use disposable profiles, synthetic accounts, and fixture services; they do not connect real mail accounts.

Technical references: [esbuild's build API](https://esbuild.github.io/api/), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security). These explain the bundling and renderer isolation primitives; FreeLM's declared capability and credential checks are application-level controls.
