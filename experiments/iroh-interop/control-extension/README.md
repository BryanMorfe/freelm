# Offline control-extension preparation

Candidate only, based on Iroh FFI v1.2.0 revision
66a8d619a4d791d458d582f312df6e0ab42bc541. Copied only the two relevant source files
from the already-local official checkout. Upstream checkout and production source
were not modified. No downloads, dependency resolution or endpoint startup.

`controls.patch` adds the same three configuration methods to UniFFI (Swift) and
NAPI (Node): clear IP transports, clear address lookup, disable port mapping.
These delegate directly to already-existing Iroh1.4.1 core APIs. They do not bind,
create keys or implement crypto. `expected-api.json` describes expected generated
names only; no generated Swift/JS/headers or prebuilt libraries were hand-patched.

Three static checks passed (`offline-validation.log`): patch reproduces candidates,
exports have matching configuration-only bodies, and the manifest explicitly keeps
network testing blocked. These checks do not establish compilation, ABI compatibility
or runtime isolation. The existing published binary still lacks these methods.

## Dependent work stopped

- Native builds require Rust>=1.91; installed compiler is1.88. No local rustup
  toolchain directory was found. No compiler was downloaded or installed.
- Cached Cargo sources do not include Iroh core sources needed for rebuilding.
- Existing cached endpoint.rs confirms `net_report_config`, but the actual
  NetReportConfig definition is not locally available. No guessed field/method was
  added. Captive-portal and other probing restrictions remain unresolved.
- Binding generation requires a matching built native library/metadata. Thus the
  expected API cannot yet be compared against generated and linked artifacts.

## Review requirements before any network test

These exports are low-level controls, not an irreversible isolation policy. A later
public preset can restore address lookup/relays; later bind calls can add wildcard
addresses. The eventual QA wrapper must reject those options and apply verified
isolation last, check actual bound sockets, and fail closed. Direct-only mode needs
no relay, no lookup, disabled port mapping, reviewed net-report configuration and
only explicit loopback transports. Forced-local-relay mode additionally needs no
IP transports and explicit loopback relay URLs; all auxiliary relay listeners and
outgoing behavior need separate review. Clearing address lookup does not prove that
all DNS/probing is disabled. No runtime isolation clearance is granted by this patch.

Independent review is recorded separately when received. Production gate remains
false. Do not run Endpoint.bind or networking examples against this candidate.

## Credential accounting unchanged

The earlier initial SwiftPM public GitHub artifact download logged multiple(7)
Keychain entries. Existing evidence does not show whether a credential was selected
or transmitted; no owner-store reinspection occurred. The subsequent cached build
with `--disable-keychain --disable-netrc` is not anonymous-fetch proof. This turn
performed no dependency fetch and did not retry that request. See the parent
experiment README and original retained log for full accounting.
