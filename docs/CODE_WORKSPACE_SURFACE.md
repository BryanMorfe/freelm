# Code workspace tabs

The numbered tab button at the far right of Code's title bar opens a separate work surface beside the conversation. Drag the divider to resize it, or expand it to fill the workspace. The left navigation and global tab toggle remain available. At narrow widths the two surfaces stack rather than shrinking primary controls.

Opening the work surface temporarily hides the Pinned summary. Closing restores its prior visibility. The summary toggle still works while tabs are open; an explicit choice becomes the saved preference.

## Files and review

- **Files** lists the selected project's host directories. Open folders or search workspace filenames. File tabs provide highlighted, searchable source, image preview, and Markdown/HTML Preview and Source controls. They are read-only in this version.
- File links in Code replies open the work surface, including `path:line`, `path#Lline`, and local `file:///` or `file://localhost/` references. Files recorded in Outputs also open there. Paths resolve on the selected execution host and remain confined to its configured project directories. Remote file authorities and embedded credentials are rejected.
- **Changes** shows recorded last-turn patch excerpts, or current Uncommitted, Unstaged, and Staged Git changes. Git review includes bounded untracked additions, does not modify the index, and disables external Git conversion/diff helpers. Nested repositories are reviewed when their directory is selected; they are not recursively merged into a parent review.
- Tab metadata is remembered per host/project. Current review snapshots belong to the task that opened them. File content is re-read from the host, never stored in tab metadata. Paired remote hosts need the new `codeSurface: 1` capability and their existing remote-tool authorization.

Native file reads use bounded regular-file operations with root and symlink checks. The service also has a conflict-checked write operation for future editing UI; there is no Save or overwrite action in this read-only surface.

HTML opens as a working preview by default; line-specific links and Find open Source. Referenced local classic scripts, stylesheets (including imports and resource URLs), images, and fonts are embedded from the selected workspace directory, including on remote hosts. Reads retain the regular-file and symlink protections and are limited to 96 resources / 8 MiB; assembled documents are limited to 12 MiB. Missing, external, or unsupported resources are explained below the preview.

HTML runs in an opaque-origin sandbox on a single-use, short-lived host-issued URL. It has no FreeLM preload/IPC, parent DOM, Node, storage, network, popups, downloads, or top-level navigation. Apps requiring JavaScript module imports, runtime file loading, browser storage, or a backend should run through a development server in Browser. This is a file preview, not an automatic build or server launcher.

## Browser and annotations

**Browser** opens an isolated Chromium web contents view. Enter an HTTP(S) URL, including a local development server, then use Back, Forward, Reload, screenshot, or developer tools. A browser is local to the computer displaying FreeLM, including while browsing a remote Code workspace; `localhost` refers to this computer.

HTTP(S) links in Code replies, research citations, and source lists open a Browser tab in this surface. Clicking a URL already open in this project's tabs selects that tab. Browser URLs are remembered with the tab metadata; Chat links continue using the external browser.

Entering a local absolute path or local `file:` URL in the address field opens it through Files, with the same workspace checks. Browser errors describe recovery steps (for example, starting the local server or checking its port) rather than exposing Electron IPC wrappers.

**Annotate page** lets the user select an element and add a comment. Continue selecting for multiple comments. Markers can be hidden, and exiting annotation mode preserves comments. **Add to message** captures the page and adds the human comments plus an image to the existing composer draft; DOM selector/text/URL/bounds are a separate text attachment. Nothing is submitted to a model until the user sends the message. Page text is marked as untrusted source material.

The browser has no application preload, Node access, filesystem routes, model tools, or main-app IPC. Permissions, downloads, external protocols, and extension loading are disabled in this first version. Sessions are temporary and separate from the user's normal browser. Switching away from the project closes its native views; reopening restores their URLs and pending annotations during the app session. Closing a tab discards that tab's pending annotations. Up to twelve tabs are shown per project.

External-app Open, browser extensions, persistent browser profiles, and a terminal surface are not included in this implementation.

## Verification

`tests/code-surface.test.ts` and `tests/remote/code-surface.test.ts` exercise host scoping, safe reads, Git modes and side-effect prevention, write conflicts, and paired-host capability handling. `tests/code-browser.test.ts` covers the browser's input validation, isolation, navigation, captures, and lifecycle. `tests/e2e/code-surface.spec.ts` exercises the rendered app with private fixtures. `node scripts/smoke-code-surface.mjs` exercises the real Electron bridge and a loopback page using a disposable profile.

`tests/code-html-preview.test.ts` covers preview resource assembly, traversal/symlink isolation, response policy, and friendly errors. `node scripts/smoke-code-html-preview.mjs` uses the actual built desktop renderer/protocol in a disposable profile to click the generated app, check local CSS/JS/image loading, verify parent/IPC/storage/network isolation, toggle Source/Preview, and test browser recovery.
