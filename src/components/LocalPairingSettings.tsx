import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { userFacingError } from '../lib/user-facing-error';
import type { LocalPairingInvitation, LocalPairingStatus } from '../mobile-types';

export default function LocalPairingSettings() {
  const api = window.desktop;
  const [status, setStatus] = useState<LocalPairingStatus>();
  const [invite, setInvite] = useState<LocalPairingInvitation>();
  const [qr, setQR] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [initialize, setInitialize] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void api
        ?.localPairingStatus?.()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    let active = true;
    setQR('');
    if (invite)
      void QRCode.toDataURL(JSON.stringify(invite), { width: 256, margin: 2 }).then((value) => {
        if (active) setQR(value);
      });
    return () => {
      active = false;
    };
  }, [invite]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(userFacingError(e));
    } finally {
      setBusy(false);
    }
  };
  if (!status) return null;
  return (
    <SettingsGroup title="Local QR pairing">
      <SettingsRow
        description={
          status.available
            ? 'Share Bots with one iPhone after you approve its identity on this Mac. Sharing starts only when you choose Enable.'
            : status.reason
        }
      />
      {status.available && (
        <>
          {!status.enabled ? (
            <>
              <SettingsRow label="Mac HTTPS address" htmlFor="local-pairing-endpoint">
                <input
                  id="local-pairing-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://your-mac.local:43121"
                />
              </SettingsRow>
              <SettingsRow
                label="Create a new local identity"
                description="Enable only for first setup. Resuming uses the existing protected identity; it never replaces one silently."
              >
                <input
                  type="checkbox"
                  checked={initialize}
                  onChange={(e) => setInitialize(e.target.checked)}
                  aria-label="Create a new local identity"
                />
              </SettingsRow>
              <SettingsRow>
                <button
                  disabled={busy || !endpoint}
                  onClick={() =>
                    void act(async () => {
                      setStatus(
                        await api!.localPairingStart!({
                          endpoint,
                          bindAddress: '0.0.0.0',
                          initialize,
                        }),
                      );
                    })
                  }
                >
                  Enable local sharing
                </button>
              </SettingsRow>
            </>
          ) : (
            <>
              <SettingsRow label="Local sharing" description={status.endpoint}>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setStatus(await api!.localPairingStop!());
                      setInvite(undefined);
                    })
                  }
                >
                  Stop sharing
                </button>
              </SettingsRow>
              {!status.active && (
                <SettingsRow>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => setInvite(await api!.localPairingInvite!()))
                    }
                  >
                    Create pairing code
                  </button>
                </SettingsRow>
              )}
              {invite && invite.expires > Date.now() && !status.active && (
                <SettingsRow>
                  <div>
                    {qr && (
                      <img
                        src={qr}
                        width={256}
                        height={256}
                        alt="Private two-minute iPhone pairing invitation"
                      />
                    )}
                    <p>Scan in Bots, then compare the phone fingerprint before approving.</p>
                    <details>
                      <summary>Enter manually</summary>
                      <textarea
                        readOnly
                        aria-label="Full pairing invitation"
                        value={JSON.stringify(invite)}
                      />
                    </details>
                  </div>
                </SettingsRow>
              )}
              {status.pending && (
                <SettingsRow
                  label="iPhone requesting access"
                  description="Compare this full fingerprint with the one shown on your iPhone. Approval grants Bots access only."
                >
                  <div>
                    <code style={{ overflowWrap: 'anywhere' }}>{status.pending.keyHash}</code>
                    <p>
                      {status.pending.approved
                        ? 'Approved. Waiting for the phone to finish.'
                        : 'Waiting for your approval.'}
                    </p>
                    <button
                      disabled={busy || status.pending.approved}
                      onClick={() =>
                        void act(async () =>
                          setStatus(
                            await api!.localPairingDecide!(
                              status.pending!.requestId,
                              status.pending!.keyHash,
                              true,
                            ),
                          ),
                        )
                      }
                    >
                      Approve iPhone
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          setStatus(
                            await api!.localPairingDecide!(
                              status.pending!.requestId,
                              status.pending!.keyHash,
                              false,
                            ),
                          );
                          setInvite(undefined);
                        })
                      }
                    >
                      Deny
                    </button>
                  </div>
                </SettingsRow>
              )}
              {status.active && (
                <SettingsRow label="Paired iPhone" description={status.active.keyHash}>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setStatus(await api!.localPairingRevoke!());
                        setInvite(undefined);
                      })
                    }
                  >
                    Revoke iPhone access
                  </button>
                </SettingsRow>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <SettingsRow>
          <p role="alert">{error}</p>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
