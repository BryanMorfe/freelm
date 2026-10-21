# Image and video moderation

Settings → Moderation has independent image and video controls: each has its own enable toggle, level and evaluator. Both default to **enabled, Low**, including existing installations without saved moderation settings. No evaluator is selected automatically. If a media type has no usable evaluator configuration (missing model/connection, unavailable or incompatible model, or no usable thinking value), FreeLM shows a warning and allows that media to generate without moderation. The other media type is unaffected. A usable configured evaluator's request, schema, decoding or classification errors still stop generation, as do policy denials. Disabling a media type skips both evaluation stages without a configuration warning; backend policies still apply.

| Level  | Always blocked                                   | Additional restrictions                                                                           | Adult gore |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------- |
| Low    | NCII; sexual or violent content involving minors | None                                                                                              | Allowed    |
| Medium | Same                                             | Sexual content and other or uncertain nudity; clearly artistic, nonsexual adult nudity is allowed | Allowed    |
| High   | Same                                             | Sexual content, all nudity (including artistic nudity), and gore; clothed sexy content is allowed | Blocked    |

## Evaluators

Choose an API connection, enabled Chat model, and explicit thinking value separately for images and videos. Both evaluator models must declare text and image input; video input support is not required. Both stages use the selected model and level for that media type. The classifier returns labels, while deterministic FreeLM code makes the policy decision. Settings exposes the complete evaluator rubric. You can configure image evaluation while leaving video evaluation unconfigured, or vice versa.

Plain generation input requests contain only the rubric and the actual generation prompt. Image edits and reference-bearing image-generation requests instead jointly evaluate the instruction and every reference image using the image-edit rubric. Masks are not depicted reference subjects. Attached images still reach the generator unchanged; only evaluator copies are normalized. The output request contains only the rubric, a neutral classification instruction and the generated media, without the user's original prompt, memories, tools or conversation history. Evaluator messages are not inserted into the conversation.

Plain generation input and all output checks request API-enforced structured output with exactly seven boolean flags:

```json
{
	"ncii": false,
	"sexual_minors": false,
	"violent_minors": false,
	"sexual_content": false,
	"artistic_nudity": false,
	"nudity": false,
	"gore": false
}
```

FreeLM sends `text.format` to `/responses`, or `response_format` to `/chat/completions` and the compatible `/chat` endpoint. The format uses `type: "json_schema"`, `strict: true`, all classification flags as required boolean properties, and `additionalProperties: false`, following [OpenAI's structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs). Evaluator APIs/models must support that contract. Unsupported-schema errors stop the request; FreeLM does not retry with weaker formatting.

The separate `nudity` flag lets High block all nudity without incorrectly classifying artistic nudity as explicit sexual content. Strict client validation remains a second check: missing fields, extra fields, string booleans, fenced JSON, refusals, incomplete responses, transport errors and unreadable media fail closed. These classifications are model judgments: an isolated image/video cannot reliably establish consent or exact age, and the feature does not guarantee detection.

Artistic nudity requires affirmative evidence of a nonsexual artistic purpose in the requested or visible depiction. Nude fine-art photography can qualify, as can sculpture and figure studies; photorealism alone does not make a depiction sexual. Beauty, attractive anatomy, scenic lighting, an ordinary nude portrait or simply using the word “artistic” does not establish that purpose. Erotic framing still sets `sexual_content`, even if a request claims to be art.

The existing seven flags distinguish three nudity cases without changing the evaluator schema:

- Clearly artistic and nonsexual: `nudity: true`, `artistic_nudity: true`, `sexual_content: false`.
- Sexualized: `nudity: true`, `sexual_content: true`; an artistic label never overrides the sexual-content block.
- Other or uncertain purpose: `nudity: true`, `artistic_nudity: false`, `sexual_content: false` when there is no evidence of sexual content. Medium blocks this nudity without mislabeling it as sexual; Low still allows it.

Plain generation input and output checks use the same rubric. Prompt evaluation classifies the actual generation prompt, which can differ from the original chat message. Image-edit input uses the contextual rubric described below. Output evaluation assesses the supplied media independently: it must not infer artistic intent from the original prompt, a caption or a filename. The stricter classification applies to new requests and does not reclassify existing media.

Evaluator failures include bounded diagnostics: HTTP status and provider error code/message, response status and incomplete reason, Chat finish reason, token counts for incomplete responses, content type/JSON decoding errors, or network/timeout codes. These distinguish unsupported formatting from oversized requests, unavailable models and exhausted output budgets. Credentials, prompt text, media data and URLs are redacted; classifier answers and reasoning are not shown. An enabled configured evaluator still fails closed, with no automatic retry or schema downgrade. Large original images can exceed a provider's HTTP request-body limit even when they fit FreeLM's media limits.

## Contextual image editing

Every enabled, configured image moderation level blocks image edits whose expected result is sexual or nude, including Low and artistic nudity. Input evaluation uses a strict ten-boolean schema: the seven common flags above plus `input_contains_person`, `edit_sexual_content`, and `edit_nudity`. The three additional flags are descriptive model labels; the client enforces the edit rule separately from the selected generation level. Settings exposes both complete rubrics.

The evaluator considers the instruction and all references jointly. For a clothed-person reference, “the top has been completely removed” describes undressing even though the instruction never explicitly says “nudity.” Person presence alone does not block a request: removing a shirt logo, adjusting exposure, changing a background, and replacing clothes with other covering clothes are permitted when their expected result is clean. The edit flags describe the expected result, including retained content: changing only the background of an already nude subject still leaves nudity and is blocked. Adding full opaque clothing can yield `edit_nudity: false` even when the source has `nudity: true`.

Output inspection sees the edited result in isolation, using the standard seven flags and no original references or prompt. For image edits, sexual content, nudity or artistic nudity in the result are denied at every enabled level. This holds the output if an otherwise harmless instruction produces unexpected sexual/nude content. Plain image generation and video level policies remain as shown above. Disabled moderation skips these rules; enabled but unconfigured moderation retains the warning-and-proceed behavior.

Reference inspection accepts embedded PNG, JPEG, and static WebP images with the same 16-image, 32 MiB per-file and 64 MiB batch bounds. Missing, ambiguous, unsupported, animated or malformed references stop a configured check. Remote URL references must be downloaded and attached before editing: mutable URLs could supply different bytes to the evaluator and generator. Original generator payloads are preserved; evaluator copies of large PNGs are recompressed losslessly. All references are inspected, including repeated `image[]` multipart fields.

## Video frame inspection

Video prompt checking happens before job creation and includes any reference image. Output checking happens when the completed video is downloaded. FreeLM decodes the actual MP4/WebM locally and samples at 0, 1, 2, and subsequent whole seconds before the end of the clip. A 15-second clip has 15 sampled frames; a 3.25-second clip has 4. Each full-resolution PNG is evaluated separately, in order, with the same strict seven-flag schema and the video policy's image-capable evaluator. The evaluator uses its connection's Chat API; legacy `videoApi` settings are ignored.

Every sampled frame must pass before the original video bytes are released. Denial, cancellation, an unsupported codec, missing duration, decoding failure, or a configured evaluator error withholds the entire video. The decoder holds one frame at a time and is closed after completion, cancellation, or failure. Desktop uses a hidden sandboxed Chromium decoder with network and application bridges disabled; browser preview uses the same decoding routine in its page. Frame decoding has a 30-second per-operation deadline, a 32-megapixel dimension ceiling, and supports clips up to 24 hours. These are decoding bounds, not a generation polling deadline.

This intentionally checks sampled visual frames only. It does not inspect audio, infer motion, or cover content between sampled seconds. Missing/incompatible evaluator configuration warns and proceeds unmoderated, as with image moderation. Job metadata may be saved while generation runs; denied video bytes never reach the gallery. Previously saved media is not retroactively evaluated.

## Enforcement and storage

- The portable guard is shared by browser preview and the Electron host. Desktop playground requests, remote host requests, and Chat/Code `image_gen.imagegen` and `video_gen.videogen` all go through it. Evaluator calls use the raw transport, avoiding recursion or duplicate evaluation. Missing-configuration warnings accompany successful responses and are retained with generated media/tool results, so they remain visible after settings change.
- Image batches are held until every output passes. Large PNGs are losslessly recompressed for the evaluator request: complete image resolution, pixels, alpha and metadata are preserved. This avoids oversized requests from generators that return uncompressed PNGs. No image resizing or lossy conversion occurs. Originals remain unchanged in the gallery and downloads. URL results are downloaded without generator API credentials and snapshotted, so the gallery cannot fetch changed media from the same URL afterward.
- Denied outputs never reach media persistence or tool results. FreeLM does not automatically delete the provider's remote generation job or assets.
- Supported media is bounded to 32 MiB per file, 64 MiB per image batch, and 16 images. Larger or unrecognized output fails with an inspection error rather than skipping checks.
- Settings live in `~/.freelm/config.json`; they contain connection/model IDs, not duplicate credentials. Legacy global enablement and level are copied to both media policies without losing evaluator selections. Legacy shapes and absence are preserved on disk until Settings is saved.
- Remote instances advertise `mediaModeration`, `moderationStructuredOutput` and `moderationPolicies: 1`. All are required for media generation and programmatic tool orchestration. Older hosts do not implement independent policy fields or the missing-evaluator warning contract. Ordinary Code commands and other tools remain available. Previously saved moderation policy on an older host is preserved when unrelated workspace changes synchronize. Updated hosts also advertise `moderationImageEdits: 1`. Hosts without this capability cannot accept image edits or reference-bearing image generation, and their programmatic orchestration is withheld so it cannot bypass the reference guard. Plain image generation and ordinary tools remain available on independent-policy hosts. Video generation additionally requires `moderationVideoFrames: 1`; an older native-video evaluator host cannot silently perform a different inspection. Host connection credentials remain on the host.

Focused tests cover deterministic levels, strict JSON, enabled defaults, configuration persistence, cancellation, input/output isolation, whole-batch rejection, downloaded snapshots, per-second video sampling, actual MP4 decoding, browser/desktop parity and remote capability negotiation. They use mock classifiers and benign media; they do not measure a real model's classification accuracy.
