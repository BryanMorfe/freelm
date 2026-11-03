# Provider compatibility

Audit date: 2026-10-21. Source baseline: `95fc3cee2048cd9da8bb952982aa31784510ba39`,
`https://github.com/BryanMorfe/freelm.git`. This matrix describes the implemented
protocols and their limits. No production provider was called in this audit.
Protocol fixtures and native app tests do **not** certify a live provider/model.

## Architecture and implemented contracts

FreeLM is an Electron desktop app with a React/TypeScript renderer. macOS and
Linux are the documented targets; Linux AppImage/deb build configuration exists.
A Windows packaging icon alone is not proof of Windows support.

Connections currently select an OpenAI-style base URL, bearer key, and Responses,
Chat Completions, or `/chat` alias. Local connections can also select experimental provider-adapter plugins; see
[Provider adapters](PROVIDER_ADAPTERS.md) for the text/tool MVP, grants and limitations.
The matrix below describes built-in protocols rather than third-party adapter certification.
`src/lib/api.ts` handles discovery, lightweight text requests, and media;
`src/lib/agent.ts` handles Chat/Code tool turns; `electron/bot-host.ts` and
`electron/bot-provider-stream.ts` own Bots. Desktop requests use
`electron/transport.ts`. Remote workspaces resolve credentials on the host and
restrict routes in `electron/instance-host.ts`; browser preview requires CORS.

| Capability | Implemented wire contract | Important boundary |
| --- | --- | --- |
| Discovery | GET `/models`; `data[]` / `models[]` IDs | Optional; models can be added manually. Capability inference is intentionally manual. |
| Text and image input | POST `/responses`, `/chat/completions`, `/chat`; JSON and SSE | Audio/video chat attachments are rejected; image capability must be configured. `/chat` is a server-specific alias, not a universal OpenAI route. |
| Tools | Responses function calls or modern Chat `tool_calls`, multi-round replay | Code/Bots need a tool-capable model. A configured text modality does not establish tool support. |
| Reasoning | Per-model, per-endpoint parameter mappings | Explicit Standard mode sends no thinking parameters. Missing modes and legacy empty mappings remain unavailable. |
| Image generation/edit | `/images/generations` JSON; `/images/edits` multipart; `data[].b64_json` / `url` | Model-specific image formats, sizes, masks and counts still apply. Native provider schemas need adapters. |
| Video | Multipart `/videos`, GET `/videos/{id}`, GET content | Pause/resume status checking is implemented. Local Stop/pause is not a provider-side cancellation request. |
| Audio | `/audio/speech` binary; `/audio/transcriptions` multipart | File workflows, not Realtime or general audio conversations. |

## Provider matrix

“Protocol candidate” means code has the relevant transport and shape; qualification
still requires a specific model, configuration and live test authorized by the owner.
There are no separately implemented native adapters for the providers below.

| Provider / official reference | Chat, Code and Bots | Media | Status / setup |
| --- | --- | --- | --- |
| [OpenAI](https://developers.openai.com/api/reference/overview/) | Responses and Chat contracts implemented; prefer Responses for current reasoning/tool models. [Current reasoning restrictions](https://developers.openai.com/api/docs/guides/reasoning) differ by model: some current models do not support `none` or Chat function calls. | Separate [Images](https://developers.openai.com/api/docs/guides/image-generation), [Video](https://developers.openai.com/api/docs/guides/video-generation), [Speech](https://developers.openai.com/api/docs/guides/text-to-speech), and [Transcription](https://developers.openai.com/api/docs/guides/speech-to-text) paths implemented. | Protocol candidate, fixtures only. Base `https://api.openai.com/v1`. Configure actual model capabilities and accepted effort values. |
| [fal.ai](https://fal.ai/docs/documentation/model-apis/inference/queue) | Selected fal endpoints expose OpenAI-like interfaces, but that does not establish compatibility for the whole platform. | Native model/queue routes, `Key` authentication, request IDs/status/result/cancel URLs and model-specific output schemas differ from FreeLM's media contract. | **Deferred / native support absent.** Changing the base URL is insufficient. Requires a dedicated adapter and remote-host route policy. |
| [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) | Chat Completions candidate; reasoning support and disabling depend on model. Provider defaults can now be selected explicitly. | Native Gemini image/video/audio contracts are not implemented by this OpenAI-shaped client. | Fixtures only. Base `https://generativelanguage.googleapis.com/v1beta/openai`; use Chat Completions. Do not assume Responses or every media task is supported. |
| [Claude OpenAI compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) | Chat Completions compatibility layer; reasoning effort, `response_format` and tool `strict` are ignored according to the provider. Native Messages API is not implemented. | Native Claude audio/media interfaces are not implemented. | Fixtures only. Base `https://api.anthropic.com/v1`; use Chat Completions and Standard where appropriate. Do not promise reasoning control or schema guarantees. |
| [OpenRouter](https://openrouter.ai/docs/api_reference/overview) | Chat Completions candidate; normalized schema still depends on selected model/provider for tools and reasoning. | No platform-wide media qualification; validate task-specific endpoints separately. | Fixtures only. Base `https://openrouter.ai/api/v1`; use Chat Completions. No blanket guarantee for all routed models. |
| [Ollama](https://docs.ollama.com/api/openai-compatibility) | Documented OpenAI subset includes Chat and Responses. Model-dependent vision/tools; Standard avoids invented reasoning parameters on ordinary models. | Do not infer OpenAI media support from text compatibility. | Fixtures only. Typical base `http://localhost:11434/v1`; local requests need no key. No live Ollama instance was used. |

Custom OpenAI-compatible gateways remain candidates only for the endpoints they
actually implement. Provider names, model ID spelling and discovery success do not
prove capability support. Credentials remain bound to the configured origin;
redirects are refused.

## Incremental fixes and regression evidence

- JSON Chat fallbacks now reject `length` and `content_filter`, matching SSE.
  Truncated background title/memory requests cannot be reported as successful.
- JSON Responses now retain `incomplete_details.reason` in lightweight and main
  agent requests; incomplete tool batches are rejected before execution.
- Known output-limit/filter failures get readable recovery guidance at the display
  boundary. Original errors remain in state and diagnostics.
- Standard is an explicitly configured, named mode. Its `useProviderDefaults`
  boolean and empty endpoint mappings are validated and persisted. The flag is
  never sent to the provider. Legacy catalogs are not silently changed, and
  adding Standard preserves existing selections/defaults.
- The Linux baseline patch completes the npm 11 optional dependency lock subtree,
  awaits remote Bot test shutdown, and gives heavy image normalization its existing
  neighboring test's timeout budget. It does not upgrade existing dependency versions.

Regression locations: `tests/api.test.ts`, `tests/agent.test.ts`,
`tests/catalog.test.ts`, `tests/desktop/bots.test.ts`,
`tests/user-facing-error.test.ts`, and `tests/e2e/catalog.spec.ts`.
Run focused contracts with:

```sh
npm test -- tests/api.test.ts tests/agent.test.ts tests/catalog.test.ts tests/desktop/bots.test.ts tests/user-facing-error.test.ts
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- tests/e2e/catalog.spec.ts -g 'explicit Standard mode'
```

## Next architecture and release decisions

1. Native fal integration is deferred by the owner. If resumed, add an explicit provider kind and capability contract before native fal support.
   Start with one bounded image endpoint and fixtures for `Key` auth, field mapping,
   result normalization and errors; then queue persistence/resume/cancellation for
   video. Keep credentials on the host, validate result URLs, preserve moderation,
   and extend the remote protocol deliberately rather than opening arbitrary routes.
2. Separate text/vision/tool/structured-output capabilities per model and endpoint.
   Detect unsupported combinations before starting runs; do not silently discard
   requested reasoning, tools or schema constraints.
3. Add an owner-authorized, opt-in live qualification suite with a fixed cost budget,
   disposable prompts and key-free result records. Current validation is synthetic.
4. Choose a project license before presenting FreeLM as an open-source release.
   This checkout has third-party notices but no root project license. No license was
   selected, and no push, publication, signed package or release was performed here.
