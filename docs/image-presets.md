# Image size presets

Reviewed September 28, 2026. These are editable, per-connection suggestions, not server capability declarations. Use **Settings → Configuration → Configure model → Image presets → Use recommended presets**, then Apply and Save settings. The playground keeps its model picker in the composer; its Image settings menu selects a quality/resolution preset and one of that preset's aspect ratios. Custom / provider settings allows any size or a blank size for the provider default.

Each profile owns its ratio/dimension pairs, so different quality levels can support different ratios. Display labels are never sent as API `quality`: a profile only sends that parameter if its optional **API quality** field is explicitly set. These open model presets leave it unset. The image API receives `size: "WIDTHxHEIGHT"`. Ratios may be approximate after model-alignment rounding.

## Qwen Image 2.1 and Qwen Image 2512

These tables reproduce the official [Qwen Image 2.1 model card](https://huggingface.co/Qwen/Qwen-Image-2.1#supported-aspect-ratios) and [Qwen Image 2512 model card](https://huggingface.co/Qwen/Qwen-Image-2512#quick-start). The `qwen-image` alias in the user's MoDIS configuration points to Qwen Image 2512; arbitrary providers can map that alias differently.

| Ratio | Qwen Image 2.1, recommended 2K | Qwen Image 2512, recommended |
| ----- | ------------------------------ | ---------------------------- |
| 1:1   | 2048×2048                      | 1328×1328                    |
| 4:3   | 2400×1792                      | 1472×1104                    |
| 3:4   | 1792×2400                      | 1104×1472                    |
| 3:2   | 2528×1696                      | 1584×1056                    |
| 2:3   | 1696×2528                      | 1056×1584                    |
| 16:9  | 2752×1536                      | 1664×928                     |
| 9:16  | 1536×2752                      | 928×1664                     |

## Qwen Image Edit

The `~1 MP · derived` profile is calculated from the official Diffusers [original Edit](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage/pipeline_qwenimage_edit.py) / [Edit Plus](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage/pipeline_qwenimage_edit_plus.py) default-sizing algorithm: approximately 1024² pixels, dimensions rounded to 32 pixels. It is not an official published seven-size table. The user's `qwen-image-edit` registration points to **Qwen-Image-Edit-2511**.

| Ratio | Derived dimensions |
| ----- | ------------------ |
| 1:1   | 1024×1024          |
| 4:3   | 1184×896           |
| 3:4   | 896×1184           |
| 3:2   | 1248×832           |
| 2:3   | 832×1248           |
| 16:9  | 1376×768           |
| 9:16  | 768×1376           |

Without explicit dimensions, the original pipeline uses the first reference's ratio; Plus uses the last reference's ratio. Use a blank custom size to delegate sizing to the provider. Direct edits in FreeLM's image viewer preserve the source image's dimensions unless Resize is explicitly selected.

## Krea 2 Turbo

The [official repository](https://github.com/krea-ai/krea-2#turbo-oss_turbo) documents approximately 1K–2K generation and shows a 2048×2048 Turbo example. Its [sampler](https://github.com/krea-ai/krea-2/blob/main/sampling.py) pads dimensions to multiples of 16. It publishes no exact seven-ratio table or universal server limit.

FreeLM's **derived** common-ratio profiles keep the longest side at 1024 or 2048, rounding the other side to the nearest multiple of 16. These are conservative client suggestions, not independently qualified resolutions or official Krea quality tiers. The square sizes follow the documented range.

| Ratio | 1K, derived | 2K, derived |
| ----- | ----------- | ----------- |
| 1:1   | 1024×1024   | 2048×2048   |
| 4:3   | 1024×768    | 2048×1536   |
| 3:4   | 768×1024    | 1536×2048   |
| 3:2   | 1024×688    | 2048×1360   |
| 2:3   | 688×1024    | 1360×2048   |
| 16:9  | 1024×576    | 2048×1152   |
| 9:16  | 576×1024    | 1152×2048   |

## Provider differences

Model IDs alone cannot establish server support. For example, [Krea's hosted Turbo API](https://www.krea.ai/docs/api-reference/krea/krea-2-turbo) advertises only 1K, and [Krea-hosted Qwen 2.1](https://www.krea.ai/docs/api-reference/image/qwen-image-21) caps each dimension at 2048. [Alibaba's hosted Edit API](https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-api) applies different rules to different hosted aliases. Those restrictions do not define the user's self-hosted open checkpoints. Edit or remove presets per connection when a provider has different limits.

Browser/API contract checks verify FreeLM's selected dimensions, optional quality values, persistence, and source-preserving edits. They do not qualify every size on a live model/runtime.
