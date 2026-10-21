# FreeLM app icon

The FreeLM mark is a folded mint **F** on a full-bleed square graphite background. The current app icon uses editable vector paths and smooth gradients, avoiding texture noise from the generated reference artwork. It has no baked-in rounded corners, outer shadow, border, or transparent padding; platform icon presentation is left to the operating system.

- `logo-app.svg`: canonical app icon source, combining the foreground vector with a separate graphite background group. Fully self-contained; no embedded bitmap.
- `logo-app.png`: 4096 × 4096 export of the app icon SVG.
- `icon-source.png`: historical 1254 × 1254 generated reference artwork, retained for comparison. It is no longer used by the icon pipeline.
- `icon.png`: 1024 × 1024 runtime PNG for desktop windows and the development macOS Dock.
- `icon.icns`: macOS bundle icon with standard and Retina sizes.
- `icon.ico`: Windows icon container. Windows packaging has not been validated on a Windows host.
- `png/`: 16–1024 px PNG sizes for Linux packages.
- `../../public/favicon.png`: 64 × 64 browser favicon.

Run `npm run icons:prepare` after editing `logo-app.svg`. It renders the SVG directly at each target resolution with the existing canvas dependency and packages those PNGs directly into ICNS/ICO containers. No additional utility download is required. Generated assets are included in the source tree, so normal builds do not need to regenerate them. Keep the square source opaque edge to edge; do not add a rounded mask or outer padding during conversion.

## Standalone foreground

- `logo-foreground.svg`: editable vector recreation of the folded F, with paths and gradients and no embedded raster image. It matches the original silhouette and placement, with smooth shading approximating the generated texture.
- `logo-foreground.png`: transparent 1254 × 1254 raster export of that SVG. This is the standalone mark, not a replacement for the square app icon.

Two built-in `image_gen` background-removal attempts were reviewed and discarded because they left edge artifacts. The final foreground files use the SVG recreation and its canvas export instead; neither uses those cutouts.

To export the PNG again with the existing project dependency:

```sh
node --input-type=module <<'JS'
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile, writeFile } from 'node:fs/promises';
const svg = await readFile('resources/branding/logo-foreground.svg');
const canvas = createCanvas(1254, 1254);
canvas.getContext('2d').drawImage(await loadImage(svg), 0, 0);
await writeFile('resources/branding/logo-foreground.png', await canvas.encode('png'));
JS
```

## Historical generated reference: final edit prompt

Mode: built-in `image_gen`, editing the original artwork, `transparent_background: false`. The October 18 revision preserves the F and replaces the background geometry.

```text
Use case: precise-object-edit. Edit target: the attached FreeLM app icon. Change ONLY the background container geometry. Preserve the existing folded mint F emblem exactly: its shape, folds, colors, shading, center placement, and scale. Replace the inset rounded-square graphite tile and transparent outer padding with a full-bleed square graphite background that fills the entire canvas edge to edge, including all four corners. Continue the existing subtle charcoal background behind the F seamlessly. The output is an opaque square app-icon source for an OS that applies the icon mask itself. There must be NO rounded outer corners, NO inset tile, NO border, NO transparent margin, NO outer shadow, NO rim, and NO floating plaque. Do not crop or enlarge the F. Keep the same centered emblem and mint-on-charcoal appearance. Produce only the revised square image.
```

## Original generation prompt

Mode: built-in `image_gen`, new image, `transparent_background: true`.

```text
Use case: logo-brand. Create an original production app icon for FreeLM, a local-first AI desktop workspace for chatting, coding, creative media, bots, and workflows. Asset type: square 1024x1024 macOS/Linux application icon, one icon only. A centered dark graphite rounded-square tile with generous continuous curved corners and subtle refined surface depth; transparent canvas outside the tile. Leave about 9% clear margin around the tile on each side so it sits naturally beside native macOS icons. Inside, create a bold, beautifully balanced abstract F emblem from two broad softly rounded folded ribbon-like forms: a tall rising stem with two open horizontal arms, suggesting openness and possibility. It must be instantly readable as an F at small sizes, with spacious negative space. Use pale mint and restrained sage-teal shading for the emblem, echoing FreeLM's mint accent on charcoal interface. Sophisticated, calm, minimal, polished native desktop design. Head-on orthographic view, crisp clean edges, only subtle material depth, no dramatic lighting. The emblem occupies about two thirds of the tile width/height. No written wordmark, no tiny details, no border decorations, no circuits, no brain, no atom or Electron logo, no sparkle/star, no knot, no extra badges, no mockup scene, no collage. True alpha transparency outside the rounded tile. Deliver just the finished icon.
```
