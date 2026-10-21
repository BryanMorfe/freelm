# Linux Computer Use

The first Linux adapter supports an **X11 desktop session** with `xdotool`,
`wmctrl`, and ImageMagick's `import` installed in `/usr/bin` or `/bin`.
FreeLM detects these tools; it does not install packages or change operating-system
permissions. Wayland, including XWayland within a Wayland session, is reported as
unavailable. Native Wayland support needs an implementation of the RemoteDesktop
and ScreenCast portals; falling back to unapproved whole-screen capture is not
acceptable.

Open the intended application before selecting it in FreeLM. The picker discovers
running windows and verifies the reported process against `/proc`; this adapter
does not launch arbitrary programs or execute desktop-file command lines. It
identifies apps by executable path plus window class, so applications sharing an
Electron executable are not automatically grouped together. App authorization is
enforced by FreeLM's Computer Use runtime before this adapter is called.

The adapter raises the selected application, captures that specific client window
with ImageMagick, and returns a JPEG no larger than 1440 pixels per side or 4 MiB.
It never requests a root-window screenshot. Captured pixels can contain sensitive
information in the authorized app. X11 does not provide the isolation guarantees
of macOS application APIs or Wayland portals; window-manager and app behavior
affect capture and input. Do not treat the X11 display itself as a security sandbox.

Each action requires a fresh, single-use snapshot, valid for five minutes, and checks
the window ID, process identity/start time, geometry, and active window. Image
coordinates are mapped back to client-window pixels. Keyboard and click events
explicitly target the selected window; some applications ignore XSendEvent input,
so acceptance by `xdotool` is not proof an application applied the action. The
model must inspect the next snapshot. A failed input is never automatically
retried. Drag uses XTEST to maintain held-button state, checks the app under the
pointer before pressing, and rechecks the foreground process, window geometry,
and pointer location along the bounded path. It releases the button even after
Stop. X11 events still share the user's desktop and are not an isolated input
channel. FreeLM's own window and known system-settings apps are excluded from
discovery. Stop aborts in-flight helper processes and invalidates snapshots.

Supported actions are click, double click, drag, bounded horizontal/vertical scroll,
bounded text entry, and named keys with modifiers. Accessibility element discovery,
`press`, and `set_value` are not supported by this adapter. The visible pointer
moves for coordinate actions; the host receives cursor events for its activity UI.

Protocol references:

- [xdotool manual](https://man.archlinux.org/man/xdotool.1.en)
- [wmctrl window-list implementation](https://github.com/Conservatory/wmctrl/blob/master/main.c)
- [ImageMagick import](https://imagemagick.org/script/import.php)
- [Wayland RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

Tests use injected process/capture fixtures and do not operate a desktop. A real
Linux X11 desktop acceptance test is required before claiming native Linux
end-to-end verification.
