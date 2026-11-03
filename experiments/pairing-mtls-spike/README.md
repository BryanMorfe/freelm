# Disposable mutual-TLS compatibility spike

Run from the desktop repo: `node experiments/pairing-mtls-spike/run.mjs`.
Requires macOS 15+, Xcode Swift, Node TLS and OpenSSL. This experiment is not
imported by the production application and changes no production pairing mode.

The runner generates short-lived synthetic CA/server/client certificates with
OpenSSL, compiles a macOS Swift URLSession client, and starts a separate Node
HTTPS process bound only to 127.0.0.1 on an ephemeral port. TLS 1.3 is required.
Certificates/keys and authorization records exist only in a private temporary
directory, removed in finally. PKCS#12 identities are explicitly imported with
`kSecImportToMemoryOnly`; URLSession credentials/cache/cookies are disabled.
No system trust roots, owner Keychain items, live grants or permissions change.

## Evidence

`RESULTS.json` records 12 passing checks:
- Swift client and Node server mutually authenticate using standard TLS 1.3.
- The connection-specific trusted root rejects a different QR identity.
- A trusted CA does not permit the wrong server hostname.
- Missing client identity and a foreign client CA fail before HTTP handling.
- A valid client certificate without device authorization is denied.
- Authorized devices reconnect after a real server process restart.
- Durable revocation denies requests before and after another process restart.
- Missing/corrupt authorization storage fails closed, never recreating a grant.

The authorization fixture uses an explicit client-certificate fingerprint allowlist,
atomic rename and fsync. It is a test of persistence semantics, not the production
authorization database or full enrollment implementation. Each Swift request runs
in a fresh process. No persistent bearer token is used.

Observed platform detail: URLSession returns NSURLErrorClientCertificateRequired
(-1206) for authenticated HTTP 403 responses. Non-secret server-side audit entries
verify that these cases completed TLS 1.3 and reached the device policy. The runner
asserts both the client result and that server decision; rejected-handshake cases
must not reach HTTP handling. Do not mistake every -1206 for certificate failure.

## Feasibility and remaining gates

This supports the proposed app-managed CA + QR trust + device-certificate model.
It does not prove production certificate issuance, iOS PKCS#12/SecIdentity lifecycle,
Keychain persistence across application upgrades, Secure Enclave use, renewal,
identity rotation, active long-lived connection closure, or crash/rollback recovery.
Fixture issuance uses standard OpenSSL, not a custom cryptographic implementation.
A future compatibility step must exercise Apple swift-certificates issuance and
real app-scoped Keychain identities in a disposable Simulator app before UI integration.
Physical camera, real-device provisioning, Local Network permission, discovery and
reachable listening remain separate approval-dependent tests. The currently open
Bots Simulator is not used by this command-line experiment.

Provisional product defaults: explicit Mac confirmation; full invitation as manual
fallback; foreground LAN-first. These are prototype choices, not live access grants.
No short-code/PAKE or cross-resource replication is implemented here. The one-phone
policy must remain separate from the transport and authorization data model.

Official references:
- https://nodejs.org/api/tls.html
- https://developer.apple.com/documentation/security/ksecimporttomemoryonly
- https://developer.apple.com/documentation/security/sectrustsetanchorcertificatesonly(_:_:)
- https://developer.apple.com/documentation/network/creating-an-identity-for-local-network-tls

See [IOS-LIFECYCLE.md](IOS-LIFECYCLE.md) for the subsequent real Simulator Keychain, renewal and active-revocation experiment.
