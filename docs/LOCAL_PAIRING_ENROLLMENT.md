# Durable local pairing — integrated validation checkpoint

2026-10-24. Desktop listener, local IPC, approval UI and native iOS enrollment are
integrated in source behind immutable `localPairingReleaseVerified = false`.
Existing public-PKI mode remains available. This is not yet a finished consumer
cross-network pairing/synchronization release.

## Implemented and tested

- Standard P-256 PKCS#10 proof of possession, QR-pinned issuer identity, short-lived
  single-use invitation, exact phone-key Mac approval, secret-bound status recovery,
  clientAuth certificate issuance and durable exact-certificate mTLS activation.
- Protected native Mac issuer/authorization record, atomic compare-and-replace,
  strict schema/key checks, fail-closed storage errors, device-only iOS Keychain
  identity, app/listener restart recovery and explicit local revocation.
- Dedicated bounded TLS listener; unauthenticated bootstrap has no Bots authority.
  Local validated IPC owns approval; remote routes cannot approve themselves.
  Revocation persists before active sockets close and cannot be blocked by a stalled
  host operation. Authorization is checked again inside the actual Bots mutation
  queue before append. Already accepted work is not cancelled by revocation.
- QR-first iOS flow, full invitation manual fallback, phone/Mac fingerprint review,
  pending recovery/reset and explicit failure reporting; no bearer fallback.
- Production helper rejects every test argument before storage and requires a valid
  matching nonempty signing team. Separate compile-time QA helper uses a distinct
  service and isolated temporary Keychain. Checked unique-output compilation is
  fail-fast; no stale helper fallback.

## Final evidence

- Desktop production build and TypeScript validation passed; iOS Simulator build
  succeeded. Unit/regression selection: **69 passed** (onboarding, Bots, enrollment,
  listener and authorization-at-commit coverage).
- Browser regression selection: **4 passed, 1 failed**. Both onboarding tests passed.
  The provider/project test reproducibly times out clicking `New chat in Studio`: the
  active `.project-row` intercepts pointer events. A frozen-source single-test rerun
  confirmed this; no forced click or unrelated sidebar edit was used to hide it.
  Combined browser validation is therefore incomplete. Failure log and trace are
  retained in the evidence directory.
- Native isolated storage checks cover process restart, stale/concurrent CAS,
  rejected QA default-storage calls, and unchanged read-only system Keychain
  search-list/default metadata. Earlier checked helper suite passed 10 tests.
- Actual Swift client integration passed: QR parse, CSR, explicit synthetic Mac
  approval, activation, real synthetic existing-thread send/read, app/listener
  restart, duplicate-send suppression, revoke and scoped cleanup. See
  `evidence/pairing-enrollment/swift-integration-report.json`.
- Loopback network simulation passed direct-route denial between logical segments,
  TLS-preserving byte relay, relay partition, persisted test outbox replay and
  restart deduplication. These are synthetic route/partition tests, not real NAT/WAN
  or production relay implementation.
- Computer Use verified Connect opens the camera-first screen, Simulator camera
  unavailable fallback, manual invitation entry and disabled empty Review action.
  Returned to the welcome screen and left updated Bots Launch QA Simulator open.
  Screenshot: `evidence/pairing-enrollment/final-bots-simulator.png`.
- Combined universal package: `release/combined-final-qa/mac-universal/FreeLM.app`.
  Ad-hoc deep/strict signature, hardened fuses, ASAR header hash, restored onboarding
  copy and production test-flag rejection passed. Machine-readable evidence:
  `evidence/pairing-enrollment/final-package-verification.json`.
  No owner signing credentials, provisioning or notarization used. Package was not
  installed or launched; the current owner app remains running and unchanged.

## Independent review and remaining gates

Independent Astra review covered storage scope, caller checks, stale authorization,
revocation blocking, pending recovery and the final mutation guard. Reported bounded
findings were fixed; this does not certify the complete future networking system.

Ad-hoc signing has no matching nonempty Team ID and cannot satisfy the production
helper caller boundary. The release gate remains false; verified distribution
signing or a separately reviewed portable trust boundary is still required. The
package builder's ad-hoc library-validation entitlement is not evidence of completed
release hardening. No live identity or sharing was enabled to bypass this gate.

Still engineering work: atomic credential renewal (current client certificate lasts
24 hours), production cross-network transport/discovery/relay and full multi-peer
replication, robust process-kill/power-loss fault matrix, and portable protected
storage. Socket teardown is coordinated within the single hosting process; the
app's single-instance boundary must remain enforced. Real iPhone camera/local-network
permission behavior and carrier/NAT/background operation remain untested.

See `PEER_NETWORK_ROADMAP.md` for established transport choices, device-owned
history/resources, conflict/deletion semantics and the infrastructure decisions.
No external operator, account, deployment or paid service has been chosen.

## Exact owner-storage incident accounting

An early native build failed (SecCode versus SecStaticCode typing), but a shell
sequence continued and the test used an older `/tmp/freelm-pairing-vault` binary.
One test called its default `read` operation expecting caller rejection. Instead,
that old helper queried **only** generic-password service
`dev.freelm.local-pairing.v1`, account `issuer-and-authorization`, with return-data
requested. Security returned item-not-found; the adapter returned `null`, and the
assertion failed. No secret or record was returned, created, updated or deleted.
No additional owner credential queries or mutations occurred. Do not describe all
runs as isolated: this one owner-store read was unintended.

The old helper also created a zero-byte `vault.lock` and otherwise empty directory
at `~/Library/Application Support/FreeLM/Pairing/`. Their timestamp matched the
failed run; inspection found only that empty file. Both were removed conditionally
without touching other owner data. No owner Keychain re-read was performed to verify
absence. The original failure log is retained. Other native QA Keychain calls used
isolated temporary stores; read-only search-list/default metadata calls verify they
do not change system settings. No search-list/default setters or trust changes ran.

The stale binaries were deleted. The reproduction script now uses unique binary
paths and checked synchronous compile subprocesses, so a failed compile cannot fall
through to an old executable. Production has no test-flag path at runtime; QA uses
its own service and rejects default-storage calls before touching the Keychain.

## References

- Apple Keychain services: https://developer.apple.com/documentation/security/keychain-services
- Apple Mac Keychain implementations: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- Apple private-keychain search-list behavior: https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/StorageManager.cpp
- Standard certificate library: https://github.com/PeculiarVentures/x509
- Electron executable-code hardening: https://www.electronjs.org/docs/latest/tutorial/fuses
