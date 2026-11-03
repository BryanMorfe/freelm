# iOS durable identity lifecycle — isolated validation

2026-10-24. Final exact Debug Simulator build passed 21 lifecycle phases in
`IOS-LIFECYCLE-RESULTS.json`. This extends the earlier macOS Swift/Node spike.
It is not production enrollment or finished consumer scan-and-connect.

## Implementation and isolation

`IdentityLifecycleQA.swift` and its MyApp entry point are gated by DEBUG AND
Simulator, with an explicit `--identity-lifecycle-qa` launch argument. The fixture
requires HTTPS on 127.0.0.1 and a private disposable test directory. No shipping
public-PKI transport code, owner credentials, trust stores, live grants, network
settings or provisioning accounts changed. Build signing was ad hoc (`-`).

The iOS app generates a P-256 private key using Security.framework and persists it
under a fresh UUID-scoped Keychain application tag, WhenUnlockedThisDeviceOnly.
Only its public key is exported through CryptoKit into PEM. A disposable standard
OpenSSL CA issues a clientAuth, CA:FALSE certificate for that public key. iOS
constructs SecIdentity using the certificate plus Keychain private key; Node TLS
requires client authentication and TLS 1.3. The renewed certificate is checked for
key matching and evaluated with Apple's client SSL trust policy against the pinned
fixture root before being stored. No custom cryptographic algorithm is used.

Public certificate/anchor metadata lives in a separate scoped Keychain record.
The fixture's authorization record binds a device public-key hash to current and
pending serials. A pending certificate is restricted to commit; it cannot read the
synthetic snapshot. Mutations are synchronous/serialized in this single-process
fixture, with atomic replacement plus file/directory fsync. This is experimental
persistence, not a reviewed production multi-process authorization store.

## Passing evidence

- Native key creation, certificate issuance interoperability, initial mTLS access.
- Wrong root explicitly rejected by SecTrust policy with no HTTP request; wrong
  certificate/private-key pairing rejected by SecIdentity creation.
- App and Node server process restarts retain authorized access through real
  test-scoped Keychain data and the persistent fixture record.
- Injected pre-write Keychain failure preserves the old active identity, including
  after app restart. No memory/plaintext credential fallback occurs.
- Injected server renewal/commit write failures return failure and retain the
  previous authorization record. Failed commit record is byte-identical.
- Pending certificate denied; old active certificate remains usable, including a
  positive request after a denied request in the same app process.
- Two-phase renewal preserves old and pending metadata until commit confirmation.
  After promotion, retired certificate access is denied.
- Post-commit Keychain write failure recovers using the persisted pending identity.
- Actual dropped commit response recovers idempotently after app/server restart.
  The runner checks promoted state and a post-save/drop audit BEFORE recovery, so
  recovery cannot falsely pass by performing the first commit.
- Failed revocation persistence does not acknowledge revocation or close the active
  stream. Successful revocation persists the tombstone then closes one live stream.
  Stream closure is observed after the durable audit event; iOS may report EOF or a
  transport error. Subsequent access and delayed pending commit are denied after
  another server restart, without resurrecting authorization.
- Every authorization-denial result correlates a unique request nonce with server
  denial evidence; cancellation by itself never suffices.
- Cleanup checks that both the Keychain private key and metadata are absent. The
  private temporary issuer/storage directory is removed, fixture exits, and the
  normal Bots app is relaunched. Computer Use verified the normal app open.

The platform error encountered is -1206 (clientCertificateRequired), not -1205
(clientCertificateRejected). An initial harness enum mismatch caused failures; it
was corrected. There is no demonstrated same-process recovery limitation in the
final run.

## Independent review

A separate Astra agent performed plan and code reviews without editing files.
Findings addressed: pending-only authority; nonce-correlated denials; explicit
trust-failure evidence; proof of persisted commit before lost-response recovery;
guarded certificate/audit exceptions; one socket close listener; scoped metadata
cleanup; and failed commit/revoke write tests. The reviewer found no remaining
must-fix blocker for this bounded experiment before final execution. The final
stream check additionally correlates persisted revocation with connection closure.

## Limits before production integration

The fixture's first issuance is an explicit synthetic local handoff; it does not
implement authenticated QR bootstrap or real Mac confirmation. Real enrollment
must bind invitation, device key and approval and prove possession before activating
authorization. Apple swift-certificates issuance has not been tested here; the
interoperable issuer is OpenSSL. No production CA/private-key lifecycle is installed.

Fault injection occurs BEFORE writes; it is not exhaustive partial-write, disk-full,
power-loss or rollback testing. Full authorization schema validation, multiple
processes, generation-bound device replacement, certificate expiry/rotation,
TLS-ticket resumption and Secure Enclave behavior remain gates. Hostname and
unregistered same-CA client negatives passed in the earlier macOS spike; those exact
cases were not repeated in this iOS lifecycle run. Simulator Keychain persistence
is not proof of physical-device lock/background behavior or upgrade recovery.

No new owner approval was needed for this isolated slice. Approvals become necessary
before live persistent owner identities, real-device installation/enrollment,
Camera/Local Network grants or reachable sharing. No root installation is required.
Provisional product defaults remain explicit Mac confirmation, full invitation
manual entry and foreground LAN-first, without granting live access.

## Reproduction

Build the existing iOS app with the Debug Simulator harness, install that exact
build in Bots Launch QA, then run from the desktop repo:

`node experiments/pairing-mtls-spike/lifecycle-run.mjs`

The runner terminates/relaunches ONLY bundle `devplaceholder.MTDMLY96.FreeLMBots`
on Simulator `A427CFD4-8CB4-4734-AD7E-C83BDB6E3D76`, never a physical device.
