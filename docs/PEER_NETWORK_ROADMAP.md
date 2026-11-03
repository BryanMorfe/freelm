# Cross-network pairing and multi-instance synchronization

Cross-network reconnection and seamless authorized multi-instance synchronization
are core requirements. LAN is one connection path, not the final product scope.
The current integrated enrollment slice establishes trust and scoped Bots access;
it does not yet fulfill this network/synchronization requirement. Its release gate
remains off. Marketing/onboarding copy is not a substitute for implementation.

## Transport and trust

Recommend a bounded Iroh interoperability spike before selecting the transport.
Iroh supplies authenticated QUIC, NAT traversal, encrypted relay fallback and
Swift/Node bindings, and supports self-hosted relays. Verify an exact pinned version,
Intel/ARM macOS plus Linux packaging (current Node prebuilt coverage is incomplete),
iOS lifecycle behavior and disabled/default discovery behavior. Compile missing
platform artifacts rather than silently dropping supported platforms.

WebRTC DataChannel with authenticated signaling and self-hostable coturn is the
fallback candidate; it has established ICE/STUN/TURN traversal but needs more
application signaling and identity-binding work. Do not invent NAT traversal or
cryptography. This document does not authorize any provider/account/deployment.

Keep stable FreeLM device/membership identities separate from addresses. Bind any
Iroh endpoint key explicitly to an approved membership using a versioned standard
signature verification path; never equate unrelated P-256 and endpoint keys. Existing
certificate/hostname checks remain intact for the HTTPS transport. Introduce a
transport abstraction and a separately verified connection implementation rather
than relaxing existing verification to accept changing URLs.

Pair once with explicit approval and host-scoped capabilities. Rendezvous only
supplies authenticated, expiring connection candidates; it cannot grant membership.
Try direct connectivity and retain end-to-end encryption through relay fallback.
Relay operators can observe endpoint identities, source addresses, timings and volume;
they must not receive plaintext Bots content, private keys or workspace metadata.
Keep encrypted forwarding buffers bounded and transient. Durable history, outboxes,
resource blobs and replication checkpoints stay on authorized user devices.

## Staged implementation and acceptance

1. Version identity/membership/transport contracts; define durable operation IDs,
   delivery acknowledgement, reconnect state and per-data replication rules.
2. Prove actual Swift/Node Iroh interoperability with synthetic identities, explicit
   discovery configuration, self-hostable test rendezvous/relay, direct/forced relay,
   wrong-peer rejection and identity persistence across restart. No public service
   is silently selected. Dependency packaging and licenses are acceptance gates.
3. Connect one owning Bots host across address changes. Persist outboxes and operation
   results; replay the same operation ID after uncertain delivery. A relayed/replicated
   message must never execute on another host. Reconcile uncertain external side effects
   instead of blindly repeating tool execution.
4. Implement membership-scoped multi-instance replication: causal checkpoints,
   offline edits, deletions, settings classification, authorized resource manifests,
   resumable content-addressed blobs and bounded quotas.
5. Validate actual different networks: IPv4/IPv6, CGNAT, blocked UDP, relay-only,
   relay outage/failover, sleeping hosts and physical iPhone foreground/background.
   Do not call loopback tests WAN validation.

Simulations must model independent network segments, partitions, out-of-order and
replayed operations, relay loss, reconnect and stale membership. They must assert
convergence/idempotency, not simply successful localhost reconnection. Current loopback tests simulate logical network segments with direct-route denial,
a TLS-preserving byte relay, relay partition and persisted synthetic outbox replay
after reconnect/host restart, asserting no duplicate message. This proves bounded
application behavior only. Real NAT traversal, transport-specific relay discovery,
out-of-order multi-peer convergence and the complete partition matrix remain to be
implemented with the selected transport. Physical carrier/NAT/background behavior needs separate testing.

## Synchronization rules to implement

- Messages/results: immutable owner-qualified IDs, append-only events, causal
  checkpoints, durable deduplication and acknowledgements after local persistence.
- Editable metadata: field-level merge policies; preserve conflicting values where
  silent resolution would discard user intent. Evaluate Automerge narrowly for
  collaborative documents, not as a substitute for authorization or execution rules.
- Deletions: durable tombstones; retain until relevant peers acknowledge or a stale
  peer is explicitly retired and required to perform full resynchronization.
- Settings: classify workspace-shared, host-owned and device-local values. API keys,
  filesystem grants, signing material and hardware bindings do not replicate by default.
- Resources: authorized manifests plus hashed blobs, quotas, resumable transfers and
  selective caching. A remote filesystem path remains an owner-host reference.
- Membership: authority-controlled grants/revocation, not freely mergeable settings.
  Revocation prevents future access; it cannot erase data a peer already received.

## Open-source/Linux and signing

No network protocol should require a user to purchase an Apple signing identity.
The existing Mac helper's caller checks remain unchanged. Its present production
backend needs an approved matching signing team; unsigned/ad-hoc builds fail closed.
That is a current Mac backend release gate, not a permanent network identity scheme.

For Linux, implement a distinct protected-storage backend using Secret Service or
KWallet, transactional encrypted authorization state and CAS. Fail closed if locked,
unavailable or if Electron selects basic_text. Never substitute plaintext/memory.
Secret Service does not provide a universal per-application caller boundary against
malicious same-user programs. Explicitly document that threat model; stronger
isolation requires a service/sandbox boundary, not just a signed-looking helper.
Prefer an in-process native storage interface or constrained non-exporting broker
for portable production backends; do not copy the current private-record-exporting
Mac executable model without its caller checks. Review and test the alternative
backend independently before enabling it.

Developers can run all synthetic protocol tests with isolated test storage and the
separate QA Keychain build without purchased identities. Genuine self-built production
support needs a reviewed platform-local trust/backend design and upgrade migration;
it must not be implemented as an override disabling current Mac validation.

## Decisions for Bryan

- Who operates public rendezvous/relays: a FreeLM-operated default, user-configured
  self-hosting, or both? No provider is selected or deployed here.
- Availability/failover, bandwidth quotas, access/abuse controls and metadata retention.
  Open source does not remove hosting, DNS/TLS maintenance or bandwidth cost.
- Confirm transient relay only. With durable storage exclusively on user devices,
  synchronization waits when every authorized peer holding the data is offline.
  Always-on peers and push notification infrastructure are separate optional choices.
- For this Mac release: authorize use of an existing approved signing identity when
  ready, or retain the disabled release gate while a reviewed self-build backend is
  implemented. No signing credential/account was inspected or used in this work.

## Primary references

- https://docs.iroh.computer/languages/swift
- https://docs.iroh.computer/languages/javascript
- https://docs.iroh.computer/about/faq
- https://webrtc.org/getting-started/peer-connections
- https://github.com/coturn/coturn
- https://automerge.org/docs/reference/concepts/
- https://github.com/automerge/automerge-swift
- https://specifications.freedesktop.org/secret-service/latest/ch10.html
- https://www.electronjs.org/docs/latest/api/safe-storage
- https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app
