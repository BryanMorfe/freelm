# Design philosophy

- Apple's design language is an explicit owner-requested direction across FreeLM, including menus, controls, settings, navigation, and other UI. Preserve established patterns, restrained visual treatment, and clear hierarchy while maintaining cross-platform usability.
- In Settings, preserve the existing sidebar/detail pages, compact rounded inset groups, and restrained controls when improving usability.
- Follow [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md) for this design philosophy and the shared component, save/cancel, accessibility, and typography requirements. Do not replace Settings with a generic dashboard or guided wizard.

# UI typography

- Main labels, text buttons, menu options, form controls, and section headers must be at least 13px. Use `var(--font-size-ui)` for the standard size.
- Keep larger existing heading and content sizes. Use color and weight to distinguish section headers rather than reducing their font size.
- Preserve the minimum at narrow window sizes; wrap or reflow the layout instead of shrinking primary text.
- Smaller sizes are reserved for secondary metadata, paths, timestamps, counts, captions, help text, and code.
- See [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md) for the shared typography policy.

# Local build and installation

- After important FreeLM changes, build and validate the desktop app, then install the verified bundle at `/Applications/FreeLM.app` so the owner has a consistent everyday testing installation.
- Check running app identities before installation. Never replace a running bundle, force-quit an owner session, or bypass save/unsaved-state prompts; wait for a safe normal shutdown.
- Preserve user data and retain a recoverable previous app bundle before replacement. Verify the installed bundle contains the validated changes and passes applicable signature/content checks, then launch it safely.
- Use disposable profiles for automated or synthetic QA; keep owner profiles and permissions intact. Report what was built, tested, installed and opened, including any remaining blocker. Local installation does not authorize publishing, notarization uploads, paid API calls or security-permission changes.

# Commits by Codex and Antigravity

- Make focused commits of your own changes. Inspect the working tree and index before editing and before committing. When a file contains another contributor's edits, stage only the hunks you own.
- Explain why the change was needed in the commit body. Record what you tested and the result, including relevant failures or checks you could not run.
- End each agent-authored commit message with an `AI-Model: <model identifier>` Git trailer. Copy the exact identifier shown in the app you used. If the app does not expose a verifiable identifier, write `AI-Model: unknown`.
- For an explicitly requested snapshot of mixed existing work, describe its provenance limits. A trailer identifies the agent preparing the commit and does not establish authorship of earlier uncommitted edits.
