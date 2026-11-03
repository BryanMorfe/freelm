# Custom nodes: initial desktop implementation

Custom nodes are a separate workflow extension system. They do not create plugins,
Chat providers, tools, or tabs. Install a local `.freelm-node` JSON file from the
workflow node chooser. Installation compiles the enclosed TypeScript using the
bundled WASM compiler; no npm scripts, dependencies, or FreeLM rebuild are needed.

Package shape: `{ "manifest": {...}, "source": "TypeScript source" }`.
The manifest contains `id`, semver `version`, `title`, `description`, named
`inputs` and `outputs` (`id`, `label`, `type`, optional `required`), declarative
`fields` (`key`, `label`, optional `kind` and `options`), explicit `permissions`,
and optional `retrySafe`. Field kinds use the existing workflow controls:
text, textarea, number, json, select, boolean, lines. Use object/list ports for
custom structured data; file ports carry durable opaque artifact references, including arbitrary binary files.

Import `defineNode` and `poll` from `@freelm/custom-node-sdk`. Export a default
object with `execute(inputs, context)`. Context includes saved `config`, stable
`operationId`, artifacts.write(name,mimeType,text), artifacts.read(reference),
progress(message), sleep(milliseconds), request(request), inference(request), stream(request), download(request), and upload(request).
See `packages/custom-node-sdk/index.ts` for the TypeScript contract.

Execution runs in QuickJS WASM with no Node, filesystem, process, or ambient fetch.
The host bounds CPU, memory, wall time, bridge calls, and JSON sizes. Cancellation
terminates the interpreter and aborts pending host services. Artifact reads require
an opaque capability present on input or created during the invocation. Artifacts
are stored separately from graph JSON; copying a graph alone does not copy files.

Installed versions are immutable and pinned by digest in saved workflows. Install
a new version for upgrades; existing graphs retain their exact reference. Removing
a version leaves ports/configuration intact and produces an actionable run error.
Retry is refused unless the package explicitly declares retrySafe. This declaration
is a developer assertion, not proof of server idempotency. Never blindly repeat a
paid job submission; submit once with operationId as the service idempotency key,
retain its job ID, and poll the existing job. New workflow runs have new IDs.

## Current limitations

Desktop network and inference services require an explicit per-version/digest grant
in the chooser's Services and credentials panel. Review exact HTTPS origins and
the scope of access to all configured inference connections before authorizing.
Revocation aborts active service calls. Removing a package version revokes its service
access before removing its registry entry; reinstalling does not restore that grant. New versions require new grants. Credential
values are encrypted by the operating system and stored outside workflows; there
is no plaintext fallback. Saving a secret is separate from granting service access.
A secret name is bound to one exact origin. Pass `{secret:{secretRef:"token"}}`
to request; the host injects the credential and redacts echoed values from replies.
Secret fields contain reference names only. Never embed keys in source or ordinary
configuration; automatic detection of arbitrary developer-supplied secrets is not
possible. Independent endpoints never enter the Chat provider picker.

`request` accepts custom HTTP methods, headers and text bodies and returns status,
headers and bounded body text. Parse JSON with JSON.parse, and protocol-specific
text in TypeScript. Redirects are rejected, cookies omitted, credential/transport
headers blocked, and there is no automatic retry. Responses are capped at 512 KiB.
`inference({connectionId,model,prompt})` invokes the existing FreeLM provider path
and returns the parsed completion response. Credentials stay in the host. It
requires a separate inference grant and does not alter the Chat provider catalog.

Only a single source module plus SDK imports is supported. TypeScript is transpiled,
not semantically typechecked at installation. There is no package-manager download,
archive support, structured-schema validation, artifact export/import, or remote peer installation yet. Inline artifact writes are limited to 512 KiB. Downloads/uploads and streams are limited
to 64 MiB each; an invocation may create 64 artifacts totaling at most 128 MiB.
The bridge allows 2,048 calls, 96 MiB of aggregate replies, and 120 seconds per invocation. Persistent job checkpoints and
crash recovery beyond the existing workflow run journal are not yet implemented.
Discovery is opt-in (`manifest.discovery: true`) and runs only when the user clicks
Discover options. `discover(context)` receives current configuration and uses the
same granted service boundary. Results are ephemeral, domain-neutral JSON.

Run `npm run build` then `npx --no-install vitest run tests/custom-nodes.test.ts`
for synthetic installation, execution, artifact handoff, cancellation, permission
denial, immutable version, async polling and inference bridge tests.
`node scripts/smoke-custom-nodes.mjs` runs the rendered chooser and native host
with a disposable profile. See docs/evidence/custom-nodes-streaming for recorded results.

Artifact references are currently shown as structured output rather than a native file preview.
The registry and artifact store persist across restarts, but moving a workflow to another host
requires installing its pinned nodes and transferring artifacts separately.

## Streaming and binary API

`for await (const chunk of ctx.stream(request))` incrementally reads decoded UTF-8.
Use `{...request, format:'base64'}` for independently encoded binary chunks (decode
each chunk separately). Iteration applies backpressure; breaking, cancellation,
timeout or grant revocation closes the stream. At most four streams are open per
invocation and 32 across the host. Credentials echoed across chunk boundaries are
redacted before chunks reach node code. Limits apply even without Content-Length.

`parseSSE(ctx.stream(request))` yields `{event,data,id?,retry?}`. It handles split
UTF-8, CR/LF boundaries, comments and multiline data. The retry field is data only:
there is no implicit reconnect, resubmission or automatic retry. Protocols other
than SSE can parse the raw text or base64 chunks themselves.

`download({...request,name})` returns `{status,headers,artifact}`; binary payloads
stay in the host and do not pass through the JSON bridge. Check status before using
the artifact. `upload({...request,artifact})` sends raw bytes (POST by default);
adding `fieldName` and optional string `fields` sends multipart form data. The host
creates its multipart boundary. Only input or invocation-created artifacts can be
uploaded. There is no arbitrary path/file read fallback.

`artifacts.writeBytes(name,mimeType,base64)` creates a small binary artifact.
`artifacts.readBytes(reference,offset=0,length=393216)` returns `{base64,size}` for
a bounded byte range. Byte offsets are independent of UTF-8 characters. Full binary
files and opaque references survive host restart; text helpers remain available.
Authenticated responses are scrubbed of literal and URL-encoded credential echoes,
including binary responses; a service echo can therefore alter those file bytes.
No general defense can prevent a deliberately malicious authorized service from
encoding credentials in arbitrary ways; review origin grants accordingly.

Examples: `binary-remote.freelm-node`, `streaming.freelm-node`, `remote-job.freelm-node`,
`inference.freelm-node`, and the local `sequence` → `analysis` pair. All are templates
or synthetic examples, never automatic live calls. Run `node scripts/validate-custom-node.mjs examples/custom-nodes/streaming.freelm-node` to validate without executing source.
