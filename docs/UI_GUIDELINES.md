# FreeLM UI design guidance

## Design philosophy

Apple's design language is an explicit owner-requested philosophy across FreeLM,
clarified on 2026-10-22. It applies to menus, controls, settings, navigation, and
other UI surfaces. Preserve established patterns, clear hierarchy, restrained
visual treatment, and consistent spacing when improving usability. Apply this
direction across macOS and Linux while respecting platform-appropriate keyboard
conventions, accessibility, and narrow-window usability.

In Settings, preserve the existing sidebar-and-detail structure and compact
rounded inset lists. Use the shared `SettingsGroup` and `SettingsRow` components,
subtle inset dividers, primary labels with secondary explanations, and trailing
controls that reflow at narrow widths.

Improve setup and discoverability within these settings pages: direct links,
clearer labels, sensible group ordering, and useful empty/error/loading states.
Keep existing save, cancel, and unsaved-change boundaries. Do not replace this
intentional structure with a generic dashboard or a guided wizard. Preserve the
typography, accessibility, spacing, and shared-component requirements below.

## Workspace shell

Feature pages use the existing `Sidebar` panel slot and `sidebar-panel` frame,
including `--history-width`, the shared header, rounded corner, chrome border,
scrolling rows, responsive overlay and global expand/collapse control. Keep the
workspace edge aligned with the titlebar. Do not force the shared panel closed
and recreate a differently sized sidebar inside the workspace. Verify sibling
screens at the same viewport, including expanded, collapsed and narrow layouts;
matching color tokens alone does not establish consistency.

## Typography

Main labels, buttons, section headers, menu items, navigation, and form controls use a minimum font size of **13px**. This matches the existing sidebar project and thread labels. Use the shared `--font-size-ui` token declared in `src/ui-tokens.css` for normal UI text:

```css
.control-label {
	font-size: var(--font-size-ui);
}
```

Larger text is appropriate for headings, conversation content, and the composer. Preserve those larger sizes instead of reducing them to the minimum. Shared native controls floor inherited sizes with `max(var(--font-size-ui), 1em)` so they remain readable inside smaller secondary text without shrinking larger inherited text.

Secondary metadata, help text, captions, timestamps, keyboard hints, and code may use smaller sizes. A primary label remains primary even when it uses a muted color. A compact button should reduce padding, not its font size.

Responsive layouts retain the same 13px minimum. Reflow, wrap, truncate where appropriate, or adjust layout space instead of shrinking navigation, buttons, or input labels below that minimum. Settings navigation labels wrap when space is limited; section headers use the same token at every breakpoint.

The Projects add button remains aligned with thread action menus: its width is 24px and its section heading keeps a 2px right inset. Typography changes should preserve this alignment.

## Settings lists

Use `SettingsGroup` and `SettingsRow` from `src/components/SettingsList.tsx` for settings content. Put the section heading above the rounded group, with related settings separated by inset dividers. Keep the setting label and explanation on the left and its control on the right. Use stacked rows for larger editors, textareas, and previews. When the content column is narrow, reflow controls beneath their labels while keeping switches beside the label. Preserve accessible control labels and existing save boundaries.

Keep these lists compact: standard rows use 10px vertical and 16px horizontal padding, labels use a 1.35 line height, and descriptions use 1.4. Dropdowns and single-line fields are 30px tall in Settings. Reduce padding and spacing instead of font size, and let longer labels and descriptions wrap naturally.

## Composer drawer

Use `ComposerDrawer` for persistent context above the composer, including goals, queued messages, and the new-task project/computer controls. Sections stack vertically inside one shared background with inset dividers. The drawer owns its frame, outer spacing, and overflow; its sections should not add their own cards or outer margins. Do not render an empty drawer. Connection setup prompts and question/approval sheets sit above it so the drawer stays attached to the composer.

## Composer controls

Use `ComposerToolbar` for the Chat and Code action row. It measures the available composer width and keeps controls on one line: collapse permissions to their shield icon first, then model and effort to a brain icon if needed. Restore labels when space returns. Keep the original menus, accessible names, selection tooltips, and font sizes in every state.

## Launch navigation

Reopen the last selected workspace surface. Home remembers Chat or Code even when another surface is selected; Audio remembers Speech or Transcription. Restore a plugin tab only after confirming that its plugin remains installed and enabled. Store these navigation preferences locally through `src/lib/navigation-preferences.ts`, separately from synced workspace data. Settings and transient dialogs are not launch destinations. Missing or invalid preferences fall back to Chat.

## Error messages

Render known failures with `userFacingError` from `src/lib/user-facing-error.ts`. Apply it at the display boundary so both saved and new errors lose IPC wrappers, exception names, provider error envelopes, and stack traces while retaining meaningful explanations and recovery steps. Keep the original error in state, diagnostic logs, and Debug views. Browser errors use `codeBrowserError` for browser-specific recovery guidance before the shared fallback. Do not apply error formatting to ordinary assistant text, commands, source code, or process output.

`tests/user-facing-error.test.ts` covers normalization and preservation. `tests/media-error-rendering.test.ts`, tool-activity rendering tests, and the disposable-profile `scripts/smoke-media-errors.mjs` cover actual presentation, retry behavior, and retention of raw diagnostics.

## Shared workspace controls (2026-10-31)

Home is the visual reference for comparable workspace chrome. Use `PanelHeader`
for Home, Workflows, Bots and Plugins: a static title and Home's mode selector
occupy the same title slot; trailing actions use `IconButton`. Do not add local
header padding, title font sizes or action dimensions. A content-page heading,
canvas toolbar, Settings heading or Projects section is a different role and
must not be forced into this header. Keep the Projects 24px action alignment.

`src/ui-tokens.css` owns the shared values. These are **FreeLM measurements and
choices**, not sizes or a grid mandated by Apple:

| Role                    | Current shared value                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI font                 | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`; use the platform system font, without downloading SF or relying on an optional Inter installation |
| Labels, buttons, fields | 13px / 18px; button weight 500, input weight 400                                                                                                                          |
| Workspace panel title   | 16px / 20px, weight 550, tracking −0.25px                                                                                                                                 |
| Caption                 | 12px / 16px, secondary information only                                                                                                                                   |
| Spacing                 | 4, 8, 12, 16, 24, 32px; optical offsets may use named tokens                                                                                                              |
| Panel header            | 48px high; 34px title region; 8px leading + 9px title inset = 17px; 13px trailing; actions separated by 8px                                                               |
| Controls                | 36px standard, 30px compact; 32px header icon; 30px dense canvas icon                                                                                                     |
| Corners                 | 9px controls, 7px icon buttons; retain domain-specific group/dialog/composer radii                                                                                        |
| Motion                  | 150ms feedback, `ease`; 240ms message entrance, `cubic-bezier(.22,.7,.25,1)`                                                                                              |

Existing larger content, page headings and composer text remain larger. The
caption token does not authorize shrinking primary labels. This slice does not
migrate code/monospace typography or all feature-specific controls. Match adjacent
controls by role and density, not by copying a nearby CSS declaration.

### Choosing controls

- `Button` primary: the main non-destructive commit or run action in its context.
  Prefer one prominent action. Style distinguishes importance; sibling buttons
  share a size. Primary appearance alone must not add a global Return shortcut.
- Secondary: supporting actions, file selection and Cancel. `FilePicker` opens a
  native chooser through a real hidden file input. Use an ellipsis because more
  input follows. Preserve accepted types, description, cancellation and reset
  before asynchronous processing so the same file can be selected again.
- Tertiary: low-emphasis contextual actions. `IconButton` is appropriate when a
  familiar icon is clear in context; always provide its accessible name and
  tooltip. Use text for ambiguous actions. Use the 32px size in panel headers.
- Destructive: deletion or removal, explicitly named, with the established
  confirmation/undo boundary. Never promote it to the default primary action.
  Cancelling ongoing work is a normal secondary action, not automatically a
  destructive action.
- Use `Select` for choices, `SidebarActionMenu` for action menus and `Switch` for
  binary settings. A selected mode uses selected/pressed semantics; it does not
  become a primary push button. Preserve their existing keyboard handling.
- Set `type="submit"` only for a form's intended submission; `Button` defaults
  to `button`. Pending actions disable duplicate activation and expose
  `aria-busy`; retain text feedback when animation is reduced. Do not discard
  draft state or change save/install boundaries as part of styling.

`SearchField` owns its icon, 13px text, compact height and focus treatment;
parents own its outer margin. Sidebar searches use 12px side/bottom margins.
Search has an explicit accessible label, and Escape clears a nonempty query.
A dismissible search (Plugins) may instead close and return focus to its trigger.
Do not wrap the primitive in another label or give its inner input Settings field
padding. Domain palettes and dialogs may retain their outer inset.

Keyboard focus uses `--focus-ring` (dark `#78a9ff`, light `#005fcc`) separately
from a customizable accent. Fields, buttons, links, Select and Switch retain a
visible outline; composite search outlines its whole container. Never replace
focus with a barely visible border or remove it without an equivalent cue.
Coarse-pointer shared controls grow to at least 44px; precise-pointer desktop
controls retain their compact sizes. Keep neighboring targets distinct.

Reduced motion disables decorative CSS animation and transition, including
pseudo-elements, and disables smooth programmatic chat scrolling. Use
`animateEntrance` for imperative entrance animation: it skips reduced motion,
cancels if the preference changes, and releases its listener. Content and
status text remain visible without animation. User-controlled media, the
workflow canvas and live recording visualization retain their domain behavior;
this is not a blanket rewrite of every frame-driven interaction.

### Apple HIG decision framework

Reviewed the official guidance on 2026-10-31:

- [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons):
  clear action labels, restrained emphasis, press feedback, coherent sibling
  sizes, destructive roles, and macOS ellipses for actions requesting input.
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography):
  a small, legible type hierarchy and system fonts. CSS system fonts in Electron
  do not automatically implement AppKit text styles or Dynamic Type.
- [Layout](https://developer.apple.com/design/human-interface-guidelines/layout):
  deliberate alignment, grouping and adaptation to resizable windows.
- [Motion](https://developer.apple.com/design/human-interface-guidelines/motion):
  brief, purposeful, optional and interruptible feedback.
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility):
  visible information, contrast, labels, keyboard operation and adequate target
  sizes. Its platform table distinguishes macOS sizing from touch platforms.
- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos):
  comfortable desktop density, resizing, precise pointer/keyboard input and
  larger touch targets when appropriate. Preserve cross-platform fallbacks.

The HIG informs these decisions; FreeLM's CSS measurements are not native point
specifications or a claim of full HIG compliance. This slice preserves the
existing material treatment rather than introducing Liquid Glass.

### Bots conversation composer

Treat the Bots composer as one rounded input surface. Its attachment, dictation
and send controls share 32px circular targets (44px for coarse pointers), with
7px padding inside the 1px border on every edge. In a single line, all controls
are vertically centered; as text grows, controls stay aligned on the bottom row.
Use the subtle shared border at rest and during pointer interaction. Keyboard
navigation into the text field changes the outer border to the neutral muted
color, without an inner textarea outline; keyboard-focused buttons retain a
neutral visible ring. This scoped exception avoids a nested blue rectangle
while preserving focus feedback in both themes.

### Verification and migration boundaries

`tests/e2e/ui-consistency.spec.ts` checks actual rendered Home/Code/Workflow/Bots/
Plugins title and action geometry at 1440px and the 820×600 minimum, dark/light
focus, keyboard search/actions, collapse/expand, package cancellation/reset/
reselection/failure/busy states, and motion preference changes. Existing sidebar,
plugin and Settings control suites protect navigation and save boundaries.
Acceptance: title text starts 17px from the panel edge with the Home text top
within 0.5px, actions center at header y+24 and end 13px from its edge; searches
are 30px tall; no horizontal window overflow; keyboard focus remains visible.

Migrate remaining buttons, dialogs and typography by semantic role in later
slices. Do not globally replace every `h2`, shrink large content, or remove
specialized canvas/composer interactions. Check minimum widths, long labels,
light/dark, keyboard and reduced motion whenever adopting these primitives.


## Conversation continuity (2026-11-02)

Pinned summary source rows share 8px vertical padding, a 2px internal gap and
1.35 line height. Show the first ten sources in their existing order, then use
an accessible See more / See less button. Expanding preserves source actions.
Scrollbar visibility is unchanged. User sends explicitly reveal the new message;
streaming alone must not pull someone away from the history they are reading.

Chat accepts immediate steering while inference is running. Discard speculative
inference, finish an already executing tool once, and skip remaining stale calls
before continuing with the new input. Code retains its existing queued steering.
The 24px bottom fade belongs to scrolling conversation content in Chat, Code and
Bots; it must not cover the composer or intercept selection and pointer events.
It is a static mask, including with reduced motion.
