# FreeLM UI typography

Main labels, buttons, section headers, menu items, navigation, and form controls use a minimum font size of **13px**. This matches the existing sidebar project and thread labels. Use the shared `--font-size-ui` token declared in `src/styles.css` for normal UI text:

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
