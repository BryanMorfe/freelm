# Computer Use

Computer Use is opt-in under **Settings → Tools → Computer Use**. It is available
in local Code tasks with an image-capable model. Chat, remote instances, and Plan
mode do not receive these tools.

Use `@Apps` in the composer, or type an app name such as `@Notes`. The app icon and
reference remain inline in drafts, queued messages and saved messages. A
`@Computer Use` reference selects the capability without choosing an app. A
mention is not an access grant.

## Authorization and UI

- Ask for approval replaces the composer with an app authorization card. Approving
  restores the original composer/draft. Navigation remains usable.
- Approve for me asks the existing reviewer to evaluate app access in the task's
  context. A denied, failed or unclear review falls back to the visible card.
- Full access permits app access automatically after Computer Use has explicitly
  been enabled in settings. None of these modes grants OS permissions.
- If an approved app needs macOS permissions, the composer shows setup controls
  while that request waits. Grant the permissions yourself, then check again to
  continue the pending request. Settings offers the same setup controls.
- Grants belong to one application and one active run. Completion, cancellation,
  setting changes, Plan mode, and Stop revoke access. There are no permanent app
  grants. Stop computer use also stops the owning agent run.
- The app opens without being activated. A compact, click-through blue agent
  cursor moves independently of the user's pointer and stays visible between
  actions. The marker hides when its target is covered, the run stops, access
  ends, or an action fails; hiding the marker does not prevent background input. A preview updates after observations/actions and remains
  available while active even when Pinned summary is hidden.
- Screenshots and accessible interface text go to the task's selected API and are
  retained in its tool history. They do not become image-edit references or task
  Outputs. The preview cache itself is bounded and not persistent.

## Tools

| Tool               | Operation                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `computer_apps`    | Discover host-verified app identities without reading windows.                                                            |
| `computer_open`    | Request app access, open without activation, return its observation.                                                      |
| `computer_observe` | Return a window-only screenshot, frame ID and accessible elements.                                                        |
| `computer_act`     | Click, double-click, drag, scroll, type, press keys, or use supported accessibility actions. Returns a fresh observation. |
| `computer_close`   | Revoke access to one app while leaving it open.                                                                           |

Actions require the latest frame ID and screenshot-relative coordinates or
observed accessibility element IDs. Frames are single-use for actions, expire
after five minutes, and are rejected if the window identity or geometry
has changed. Another application taking focus does not invalidate a frame. Desktop actions are serialized across tasks. Computer tools must be
called directly; JavaScript orchestration cannot forward desktop screenshots and
lose their provenance. App content is untrusted data, not authorization.

Each open, observation, and completed action captures the selected app window
again. The returned image and window bounds describe the same capture region;
window bounds are desktop points, while action coordinates are pixels relative
to the returned image. The native adapter handles scaling and the window origin.
Do not add a desktop offset or reuse coordinates from an earlier frame. If the
window or sheet changes during capture, request a fresh observation before acting.

Use only the actions advertised by an accessible element. `press` activates a
pressable control; `select` selects a native row or item advertising `select`,
such as a file dialog's sidebar entry. Selection is validated against the latest
returned frame and is not an alias for pressing a row. A dispatched action is
not proof that the UI changed: inspect the new observation for the intended
result instead of repeatedly sending input when its effect is uncertain.

This is shared-desktop automation, not an OS sandbox. Separately authorized shell
commands retain their existing access. App permission is not authorization for
unrelated sends, payments, credential entry or other consequential actions.

## macOS

Requires macOS 14 or later. A bundled universal Swift helper uses ScreenCaptureKit
to capture the live display composition with only the authorized window included,
cropped to that window's bounds. This avoids a sheet capture inheriting its parent
window's cached image and geometry. It does not capture the entire desktop.
Accessibility supplies app, window, and element identities. Its AppKit event loop
keeps application state current; opening waits briefly for an active usable
window. Accessibility tree collection uses a global message timeout, batched
attributes, and a bounded time budget; a partial tree is reported while preserving
the screenshot. FreeLM's own window and System Settings are excluded from model
app discovery.

Mouse and keyboard events address the exact observed window and its owning
process through dynamically resolved SkyLight functions. A mouse event carries
both a desktop location and a separate location in points from the window's
top-left. Screenshot pixels are scaled before either location is calculated.
Mouse events retain their native subtype, click count, button and individual
timestamps; they are not relabeled as touch events. AppKit accessibility actions
remain available. There is no global HID fallback, cursor
warp, application activation or foreground-keyboard defocus. If the required
macOS functions are absent, input reports an unsupported-capability error.

The selected window remains bound to the authorized application's AX tree.
An exact AX window ID also permits an Open/Save panel hosted by that app's view
service. When an exact ID cannot be matched, only one unambiguous same-app window
with matching geometry is accepted. Background windows may be covered by other
apps; desktop hit-testing does not gate their input. Minimized/off-screen windows
still require restoration. Window changes require a new observation.

This uses private macOS APIs and does not guarantee that every app accepts
background keyboard or mouse events. In particular, some browser fields and
menu shortcuts require app-specific handling. Prefer advertised accessibility
`press`, `select`, and `set_value` actions. Dispatch does not acknowledge delivery:
inspect the returned observation and do not repeat ineffective input. FreeLM
does not transfer the user's focus to work around an app rejecting input.
For WebKit text controls, `set_value` first confirms a DOM-local text selection,
then writes the value once and checks the readable AX value over two observations.
It does not set the app's AX focus or activate its window. Native readable text
fields also receive a value readback. An acknowledged setter that leaves the
value unchanged produces an explicit error instead of silent success.
Screenshots are taken after the bounded accessibility read and validated against
window identity and geometry. These checks reduce stale frames but cannot freeze
an application's animations or content changes.

System-wide keyboard shortcuts remain unavailable. Held drags are released via
the same target process/window on cancellation, never through the user's desktop
input stream. Drag coordinates use a typed screenshot-to-screen transform.

Use **Request permissions** to trigger macOS's prompts. The user must grant
Accessibility and Screen Recording in System Settings. **Reveal helper** locates
`freelm-computer` if it needs to be added manually. Depending on macOS attribution,
the entry may be FreeLM or the helper. **Check permissions** never requests or
grants access. After a denied status, the next check recycles the idle native
helper so an earlier cached denial does not persist. It waits for any active
native operation to finish before recycling. Follow macOS's quit-and-reopen
instruction if the system displays one.

Status checks also report a known locked screen, inactive user session, or sleeping
displays separately from OS permissions. These conditions stop input with an
unlock, switch-session, or wake-display instruction; they do not request new
permissions or change app authorization. After restoring the desktop, observe the
authorized app again to obtain a fresh frame. The optional `screenLocked`,
`sessionActive`, and `displaysAwake` status fields are omitted when the native
probe cannot determine them; missing fields do not imply a locked or sleeping
desktop. Settings shows the same guidance when checking permissions.

Check status through the installed FreeLM app. A helper launched from a terminal,
Codex, or a development Electron process can have a different responsible process
for macOS privacy attribution; its result does not establish the installed app's
permission state. Old app copies can also appear as separate entries with the
same FreeLM name. Use the current installed app and the helper revealed by that
app's settings.

Local macOS packaging requires a signing certificate by default. Use the same
Apple-issued certificate and stable app/helper identifiers across updates, and
keep the installation path fixed. Switching from an older unsigned or ad-hoc
build may require granting permissions again. The explicit ad-hoc packaging
fallback does not provide a stable identity: its code hashes change when the
signed executable or bundle changes. Do not replace the designated requirement
with an identifier-only rule to conceal this limitation. See the README's
packaging instructions for certificate selection and the prototype fallback.

Builds compile both arm64 and x86_64 helper slices, combine them with `lipo`, and
sign the helper. Packaged resources include the executable. Cancellation releases
any held drag button and terminates the helper; a bounded hard-kill fallback
prevents queued input from continuing.

## Linux

The current adapter supports **X11**, with `xdotool`, `wmctrl`, and ImageMagick
(`import`) installed. It discovers already-running applications. Capture and
explicit-window keyboard events do not activate the target. Process identity,
window identity and geometry are checked around capture/input.

Independent coordinate clicks, scrolling and dragging are currently unavailable:
xdotool cannot provide these coordinates without moving the user's physical
pointer. Such requests return an explicit capability error, with no global-input
fallback. Linux does not yet provide an accessibility element tree; `press`,
`select`, and `set_value` are also unavailable. Some apps ignore synthetic X11
keyboard events, so verify the returned observation.

**Wayland is not implemented.** It reports that limitation rather than attempting
to bypass the desktop portal. A future Wayland adapter needs RemoteDesktop and
ScreenCast portal sessions plus PipeWire/EIS integration.

## Verification

The default `npm run test:computer-use` smoke checks discovery, passive permission
status, and IPC sender restrictions without capture or input. The optional
`node scripts/smoke-computer-use.mjs --exercise-fixture` path requires
`FREELM_SMOKE_EXECUTABLE` pointing to the packaged app and preexisting OS grants.
On macOS, set `FREELM_SMOKE_LAUNCH_SERVICES=1` to launch the registered app through
LaunchServices. Directly spawning its executable from a test runner can change
macOS permission attribution. Both launch paths isolate all app data in a
temporary profile; neither requests new permissions.
It uses a temporary offline AppKit/WKWebView fixture rather than the user's applications,
and does not call an inference provider or grant permissions. The fixture writes
its own text/click/drag state for independent confirmation of input delivery.
The smoke covers the fixture with a separate foreground window and checks its
input sentinel, foreground process and physical pointer throughout delivery.
Its WebKit page reports real DOM events and values independently of the tool's
return value. Coverage includes a nested button, drag down/move/up and endpoint,
Unicode typing, Backspace, and `set_value` persistence after blur and form readback.

`--exercise-dialogs` runs a separate real Electron fixture with native Open/Save
panels, temporary image files, and independent dialog completion results. It
does not mock the file chooser or substitute DOM clicks for Computer Use. The
default covers file-icon coordinate selection, accessibility selection when
advertised, and Save-panel Go-to-Folder navigation. Use `FREELM_DIALOG_CASE=click`,
`select`, or `save` to isolate a failing case. It keeps an unrelated disposable
host window foreground and checks that input does not move the physical pointer.
For a compiled candidate helper, `FREELM_SMOKE_NATIVE_HELPER=/absolute/path` replaces
only the helper spawn in that disposable host; it does not modify the installed
app or its permissions.

The October 9, 2026 live Electron panel checks are **not passing**: a coordinate
file-icon click followed by the native confirmation action did not complete the
Open panel, and its AXImage file item did not expose a writable selection action.
An experimental host-process input route also failed, so production routing was
left unchanged. A compact Save panel exposed an exact AX window ID absent from
the screen-capture window list; the helper rejected the unmatched target before
keyboard navigation could be tested. It must not guess a different window or
claim that event dispatch proved delivery. Native picker delivery remains an
open issue. The same run did verify that a locked Mac produces explicit unlock
guidance before input instead of the earlier generic bounds/timeout failure.

`tests/computer-input.test.ts` checks actual CGEvent-to-NSEvent conversion against
an unshown window, including nonzero window origins and Retina coordinates.
It does not post input and is not a substitute for the live fixture. This catches
putting desktop coordinates into the window-local event field, even when the
screen capture and screenshot-to-desktop mapping are themselves correct.

Mock adapter tests and successful compilation are not proof of native input or
capture. Linux behavior currently has injected adapter coverage; it has not been
verified on a real X11 desktop in this checkout. Wayland remains unsupported.

## References

The interaction flow follows the user's October 7 recording. The native runtime
is FreeLM's implementation; the OSS Codex CLI does not contain the production
ChatGPT native Computer Use runtime.

- [ChatGPT Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [OpenAI computer use loop](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Apple application state and main-run-loop updates](https://developer.apple.com/documentation/appkit/nsrunningapplication)
- [Apple accessibility timeout scope](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)
- [Apple Accessibility APIs](https://developer.apple.com/documentation/applicationservices/axuielement_h)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

Background event routing was informed by the MIT-licensed Cua driver at commit
`c1c2b5fee428c3a39bebe5e77549c3d3525a608d`:

- [Exact-window mouse metadata](https://github.com/trycua/cua/blob/c1c2b5fee428c3a39bebe5e77549c3d3525a608d/libs/cua-driver/rust/crates/platform-macos/src/input/mouse.rs)
- [SkyLight symbol contracts and focus caveats](https://github.com/trycua/cua/blob/c1c2b5fee428c3a39bebe5e77549c3d3525a608d/libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs)

FreeLM deliberately omits the reference's foreground-defocus, HID fallback,
and raw private authentication-object memory access.

The current native event round-trip tests are authoritative for coordinate
conversion on the tested macOS release. In particular, they show that
`CGEventSetWindowLocation` needs a window-local point and that field 58 is the
event timestamp; some comments in the reference describe those fields differently.

- [WebKit accessibility text selection and value editing](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/accessibility/AccessibilityRenderObject.cpp)
- [WebKit asynchronous AX setters](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/accessibility/mac/WebAccessibilityObjectWrapperMac.mm)
