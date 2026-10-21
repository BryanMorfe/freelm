# Desktop interaction latency

The installed macOS build was x86_64 on an Apple Silicon Mac and both its main and renderer processes were translated by Rosetta. The local Node.js packaging toolchain was also x64, so an unspecified Electron build architecture inherited that target.

`npm run package:mac` now produces a universal app. Apple Silicon and Intel Macs use their native slice, regardless of the Node.js toolchain architecture.

## Controlled runtime comparison

The same production renderer and isolated workspace were run twice with official Electron 44.4.5, once as arm64 and once as x64. Explicit-focus repeats confirmed visible, focused windows and documents, with identical default background throttling. These tests made no real provider requests or changes to the user's workspace.

| Interaction | Native arm64 | x64 under Rosetta |
| --- | --- | --- |
| Warm typing, typical presentation delay | 8–16 ms | Frequently tens of milliseconds, with repeated stalls |
| Model picker click, focused repeat | No task over 50 ms | 786 ms elapsed / 18.5 ms thread CPU |
| Short saved chat navigation, focused repeat | No task over 50 ms | 1,125 ms elapsed / 26.1 ms thread CPU |
| Dense Markdown history mount, focused repeat | About 73 ms | 14,730 ms elapsed / 200.6 ms thread CPU |

The dense history contains 40 messages and exceeds the current user's thread sizes. Native ARM also had a one-time frame-presentation pause just after activation, with no JavaScript task over 10 ms. These measurements support correcting the runtime architecture; they do not imply every native frame is below 16 ms.

## Main-thread media work

Cold encoding of a new large image previously sized and hashed JSON synchronously before yielding. Media encoding now consumes the existing bounded JSON serializer once for sizing and hashing, yields to the event loop after each 1 MiB, and reuses the prepared payload for the atomic write. Content hashes, exact serialized bytes, full originals, and warm immutable caching remain compatible.

Native Electron measurements of the maximum main event-loop gap:

| New media string | Before | After |
| --- | --- | --- |
| 20 MiB | 26–28 ms | 4–8 ms |
| 64 MiB | 79–88 ms | 9–10 ms |

These measure local storage work, not provider generation latency. Full-resolution data URL mounts and startup hydration still have bounded costs and may merit separate work if they remain noticeable after native packaging.

## Validation

- Production TypeScript/Vite/Electron build passed.
- All 405 unit tests passed, including cooperative serialization, exact Unicode bytes and media hashes, full-original round trips, and immutable-cache reuse.
- Isolated native image smoke passed with a 257 MiB gallery, a new 20 MiB API image, vision continuation, autosave, and persistence after restart.
- The development-signed universal bundle was installed at `release/mac/FreeLM.app`; its embedded main, preload, and renderer files match the latest production build. Deep signature verification passed.
- The reopened app's actual main and renderer processes both report `Code Type: ARM64`. Composer typing, the model menu, saved chat navigation, the current image gallery, and Settings were checked through the native UI without sending a provider request.
- The current configuration and workspace files remained byte-for-byte unchanged after the restart and UI checks (14 chats, 2 projects, 28 generations). All 31 existing media files retained their sizes and modification times after restart. The prior Intel app is retained in `release/mac-x64-before-native-20260930/FreeLM.app`.

Detailed traces and raw measurements are in `/tmp/freelm-performance-renderer/` and `/tmp/freelm-perf-main/`. Packaging and regression logs are in `/tmp/freelm-performance-20260930/`.
