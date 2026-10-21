# Plugins

Plugins provide account-connected tools to Chat, Code, and explicitly selected Bots, and can extend the Chat/Code composer through general surface APIs. Manage them in **Settings → Integrations → Plugins**. Plugin settings save immediately on the local computer, separately from workspace settings. Existing MCP servers and skills remain available in Code through their existing settings.

## Planned integrations

[Slack plugin — deferred proposal](SLACK_PLUGIN.md) records individual bot identities, two-way messaging, reminders, and task updates. It is not an available plugin yet.

## Plugin types

FreeLM supports both remote Streamable HTTP MCP integrations (JSON manifest version 1) and independently packaged TypeScript/JavaScript plugins (ZIP manifest version 2). Account integrations reuse host-owned accounts, public-client OAuth with PKCE, encrypted credentials, and explicit account/tool grants. Local packages can add model tools, custom workspace tabs, and API v2 surface extensions; their source is compiled locally at installation and runs through a restricted SDK. See [Plugin SDK](PLUGIN_SDK.md) and the [Notebook example](../examples/plugins/notebook/README.md).

Import a `.freelm-plugin` or `.zip` package in Settings to review, compile, and install it. Package builds do not run npm or install scripts. A plain JSON manifest remains a remote MCP configuration and cannot install source code. Gmail operations and a public marketplace are not bundled.

An application registered with the integration's authorization service is assumed to exist. Supply its public client ID and endpoints in the manifest. No confidential client secret belongs in a distributed desktop manifest. The service must support a loopback callback (`http://127.0.0.1:<ephemeral-port>/oauth/callback`) and public-client PKCE. Register the stable `/oauth/callback` path using the provider's native-app loopback configuration; the port is selected at sign-in.

OAuth for a remote MCP service authorizes that service. A Google OAuth token intended for Gmail must not be forwarded to an unrelated MCP server. A Gmail integration needs an independent local plugin that calls Google directly, or an MCP service that owns its upstream Google connection and issues its own MCP access tokens. Google app registration alone does not provide that adapter or service.

## Connect a plugin

1. Import a manifest or package and review its identity, capabilities, server URL (for MCP), and authorization settings before installing it. Importing does not sign in or grant tool access.
2. Add an account with a recognizable label. OAuth plugins open the system browser for sign-in. The label is user-provided, not verified account identity from the provider.
3. Discover the account's tools. New tools remain disabled until explicitly selected.
4. Enable only the tools and surfaces you want: Chat, Code, and/or particular local bots. Enabling a tool for a surface authorizes execution without a separate per-call prompt, including tools that change external data. Server read-only annotations are informational and never grant permission.
5. Allow connected remote clients separately if desired. Execution uses credentials on this host; it does not copy credentials to the remote computer. Remote users cannot administer plugin accounts through this feature.

Disabling the plugin, removing tool access, disconnecting the account, or removing the plugin prevents subsequent calls, including from already-running conversations. An external operation already accepted by a service cannot necessarily be cancelled or undone. Reconnect handles expired or revoked authorization. Disconnect removes local credentials and attempts provider revocation when configured.

The selected model receives tool results, including account data the tools return. It does not receive OAuth tokens. Treat plugin content as untrusted source material, not instructions. Plugin access does not enable arbitrary local MCP servers, files, commands, or skills in Chat or Bots. Bot reaction notifications do not expose plugin tools. Code Plan mode excludes plugin tools in this first version.

## Surface extensions

API v2 plugins can read authorized recent conversation text, run text inference, edit drafts, add placeholders and shortcuts, create attachments, and contribute native rows or custom views to the composer drawer. These are separately declared capabilities. A surface-only plugin does not need an account: review the package, install it, and enable Chat and/or Code access. Native plugin settings include model selection and save immediately.

The [Follow-up Prompts example](../examples/plugins/follow-up/README.md) uses these general APIs to generate an optional placeholder with Tab acceptance. Independent [attachment](../examples/plugins/attachment-drawer/README.md) and [selected-text](../examples/plugins/rewrite-selection/README.md) examples use the same runtime. Accepting a suggestion edits the draft; it does not send it. See the [API v2 contract](PLUGIN_SDK.md#api-v2-general-surface-extensions) for lifecycle, ownership, and inference bounds.

## Remote MCP manifest

Example for an existing remote MCP service; replace the example values with that service's registered application configuration:

```json
{
	"manifestVersion": 1,
	"id": "com.example.productivity",
	"name": "Productivity",
	"version": "1.0.0",
	"description": "Search and manage items in your connected account.",
	"author": "Example",
	"homepage": "https://example.com",
	"mcp": { "url": "https://tools.example.com/mcp" },
	"auth": {
		"type": "oauth2",
		"clientId": "YOUR_REGISTERED_PUBLIC_CLIENT_ID",
		"authorizationUrl": "https://accounts.example.com/authorize",
		"tokenUrl": "https://accounts.example.com/token",
		"revocationUrl": "https://accounts.example.com/revoke",
		"scopes": ["items:read"],
		"resource": "https://tools.example.com/mcp"
	}
}
```

Public services can use `"auth": { "type": "none" }`; accounts then represent independently labeled tool grants, not authenticated identities. HTTPS is required except for literal loopback addresses used in development. Embedded credentials and executable fields are rejected. OAuth endpoints are explicitly configured in this version; automatic authorization-server discovery, dynamic registration, confidential clients, arbitrary custom redirect schemes, and automatic scope escalation are not implemented.

Updating a plugin uses its stable `id`. Endpoint/authentication changes invalidate previous account authorization and grants; sign in and grant access again. A manifest cannot silently inherit authorization for a different service.

## Storage and runtime

Plugin state lives under `~/.freelm/plugins/`, or its `FREELM_HOME` override. Tokens use FreeLM's OS-backed encrypted credential storage. macOS uses its system keychain; Linux requires a secure storage backend and rejects insecure fallback storage. Migrating the directory does not guarantee OS-encrypted tokens can be decrypted on another computer; reconnect there.

`src/plugin-types.ts` defines renderer-safe contracts and the shared tool-provider boundary. `electron/plugins/host.ts` owns persistence, OAuth, discovery, and execution. `electron/plugins/packages.ts` compiles local packages; `runtime.ts` runs their handlers through WASM workers. Electron IPC validates the calling application window; account administration is absent from the remote API. Execution rechecks the current host-owned account, plugin state, surface/bot grant, and exact tool allowlist. Schemas and results are bounded. Tools have account-qualified stable names.

OAuth uses a random loopback port, state validation, PKCE S256, cancellation, and a bounded lifetime. Refreshes are shared across concurrent calls. Credentials stay outside renderer snapshots, prompts, schemas, and diagnostics. Credential-bearing requests do not follow redirects.

## Validation

Use fixture OAuth/MCP servers and isolated `FREELM_HOME` directories. Do not connect real user accounts or invoke real write tools during automated QA. Test login/cancellation, token storage and renewal, grants/revocation, persistence, unknown tools, remote denial, and both model API formats. UI fixtures cover disconnected, connected, reconnect-needed, unavailable/remote, dark/light, and narrow states.

`npm run test:plugins` runs the actual desktop renderer, preload, and host against local MCP/model fixtures in a disposable profile. Set `FREELM_SMOKE_EXECUTABLE` to a packaged executable to repeat that check on a release build. OAuth and host boundary tests live in `tests/plugins.test.ts`; Settings interaction checks are in `tests/e2e/plugin-settings.spec.ts`. Storybook includes **Settings → Plugins** states.

`npm run test:plugin-surfaces` exercises API v2 package installation, actual isolated plugin execution, native inference transport, composer transactions and cancellation, attachments, custom views, Chat/Code, and light/dark layouts. It also accepts `FREELM_SMOKE_EXECUTABLE` and uses a disposable profile with a local model fixture. `node scripts/check-plugin-runtime-cpu.mjs` verifies thread CPU accounting and runaway-code termination in Electron.

Provider-specific sign-in and real Gmail operations require a concrete plugin/service and registered application configuration; fixture tests do not establish those outcomes.
