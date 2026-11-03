# Iroh binding compatibility evaluation

2026-10-24. Isolated experiment only. No production packages, build scripts, iOS
project, owner profile, installed app or onboarding files were changed.

## Pins and actual artifacts

- Node `@number0/iroh` **1.2.0**, exact npm lock with artifact integrity hashes.
- Swift package **1.2.0**, revision
  `66a8d619a4d791d458d582f312df6e0ab42bc541` (Package.resolved).
- That release's Cargo.lock resolves core `iroh` **1.4.1**. Do not infer core
  version from binding version or older web-cache snippets.
- Swift binary checksum in the release manifest:
  `4a97b06ecb1d418e17a96a45b6c7e5d063a12a6dfb6600389a7b5b2ae21ae18a`.
- Bindings are MIT OR Apache-2.0; distribution still requires a transitive license
  inventory, notices and binary supply-chain review. No architecture commitment yet.
- Node requires >=20.3.0. Published macOS binary is ARM only: installed Intel
  Node 22.17.0 failed to load `@number0/iroh-darwin-x64` (real failure).
  Official Node 22.17.0 ARM archive downloaded to /tmp and checked against its
  official SHA256 manifest; system Node was not replaced.
- Swift artifact inspection: iOS arm64 device, arm64/x86_64 Simulator, arm64
  Catalyst and arm64 macOS; no Intel macOS slice. Minimum iOS17.5/macOS14.5.
  Published Node Linux targets include x64/arm64 glibc+musl and armv7. Linux and
  Intel source-build support were inspected, not executed on this Mac.
- Native source builds require Rust >=1.91; installed compiler is 1.88.

## Completed evidence

`offline-results.log`: **2 passed** using real ARM Node native bindings and the
compiled Swift executable. Swift verifies Node's Ed25519 signature, returns its
own signature and identical public identity, and Node verifies it; a second Swift
process reloads the same disposable key. Wrong-key and changed-message signatures
reject. Temporary synthetic seed files have mode0600 and are removed at test end.

A standard Node P-256 signature fixture binds an approved membership/epoch to the
Iroh endpoint public key. Substitution, modified payload and stale epoch reject.
This is an offline authorization fixture, not a finished enrollment wire protocol
or proof of remote transport authentication. No custom cryptographic primitives.

`swift-offline-build.log`: successful Swift build with `--disable-keychain
--disable-netrc`. `isolation-preflight.json`: deliberately fails closed before
endpoint construction because published controls are missing.

Run offline checks with ARM Node:

```
swift build --disable-keychain --disable-netrc
/tmp/node-v22.17.0-darwin-arm64/bin/node --test offline.test.mjs
/tmp/node-v22.17.0-darwin-arm64/bin/node isolation-preflight.mjs
```

## Why no network peer was started

Exact core1.4.1 source confirms minimal preset only installs crypto. The underlying
builder retains default IPv4+IPv6 wildcard transports and **enabled port mapping**.
A single `bindAddr("127.0.0.1:0")` replaces only IPv4; IPv6 remains wildcard.
Both loopback bind calls can restrict socket addresses, but neither disables the
portmapper. Neither Node nor Swift v1.2.0 exposes core `portmapper_config`,
`net_report_config` or `clear_ip_transports`. Minimal is not sufficient evidence
of local-only isolation. No permissive fallback was attempted.

Direct, forced-local-relay, partition/reconnect and transport dedup tests are
**not run**, not passed. No Iroh Endpoint, discovery, service or relay was started.
No public relay/rendezvous, router port mapping or live device was used by this
experiment. Dependency downloads used public official GitHub/npm/Node sources.
No true WAN/NAT validation is claimed.

## Smallest next engineering step

In an experiment-only fork pinned to the above revision, expose core's explicit
`PortmapperConfig::Disabled`, restricted net-report configuration and
`clear_ip_transports` in both bindings. Build with a local Rust>=1.91 toolchain,
including Intel macOS artifacts, regenerate bindings, and test the controls before
any bind. This is an ordinary wrapper over existing APIs, not custom cryptography.
Bind both loopbacks for direct mode; clear all IP transports for forced relay.
Use only explicitly configured loopback relay/address exchange; verify no wildcard
socket, public discovery/default relay or automatic port mapper exists. Configure
local relay diagnostics, metrics and auxiliary listeners to loopback as well.
Then run real Swift/Node QUIC, wrong-peer handshake, membership check, relay outage,
process restart, persisted outbox and duplicate-operation tests. Keep release gate
false and production dependencies unchanged throughout.

## WebRTC comparison

WebRTC DataChannel with authenticated signaling and coturn remains a credible
fallback. It supplies established ICE/STUN/TURN and DTLS/SCTP, but FreeLM still must
bind authenticated signaling/certificate fingerprints to approved membership and
implement reconnect, durable outbox and replication. It does not solve grants or
synchronization automatically. Electron has browser WebRTC; Node has the independent
node-datachannel/libdatachannel stack (MPL-2.0), while Google's native WebRTC source
is BSD-style with additional third-party notices. iOS/desktop artifact provenance,
architecture support, local-only ICE configuration and licenses need their own
pinned build-and-test spike. None was installed or executed here. Do not switch
architecture merely because Iroh's published wrapper lacks isolation controls.

## Unexpected SwiftPM credential lookup

The first `swift build` used SwiftPM defaults. Its public GitHub artifact download
logged: `multiple (7) keychain entries found for 'https://github.com'`.
This shows a credential lookup occurred; no credential values appeared in output.
The log alone cannot establish whether a credential was selected or sent in an
Authorization header. Do not claim all work avoided owner credential access.
No explicit credential read, signing identity access, credential mutation or account
login was requested by the experiment. No follow-up owner-store inspection was
performed. The process completed before this warning was examined. All later
SwiftPM commands explicitly disable Keychain and netrc lookup. Original build log
is retained as `initial-swift-build.log`; subsequent build succeeded with those
lookups disabled. This incident is separate from the earlier pairing-vault incident.

## Primary sources

- https://github.com/n0-computer/iroh-ffi/tree/v1.2.0
- https://docs.iroh.computer/languages/javascript
- https://docs.iroh.computer/languages/swift
- https://github.com/n0-computer/iroh/blob/v1.4.1/iroh/src/endpoint.rs
- https://github.com/n0-computer/iroh/blob/v1.4.1/iroh/src/portmapper.rs
- https://github.com/paullouisageneau/libdatachannel
- https://github.com/murat-dogan/node-datachannel
- https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE
