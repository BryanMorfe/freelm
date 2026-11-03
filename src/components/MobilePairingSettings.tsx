import LocalPairingSettings from './LocalPairingSettings';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { userFacingError } from '../lib/user-facing-error';
import type { MobileInvitation, MobileStatus } from '../mobile-types';

export default function MobilePairingSettings() {
  const api = window.desktop;
  const [status, setStatus] = useState<MobileStatus>({ enabled: false, sessions: [] });
  const [endpoint, setEndpoint] = useState('');
  const [bindAddress, setBindAddress] = useState('127.0.0.1');
  const [invite, setInvite] = useState<MobileInvitation>();
  const [qr, setQR] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const refresh = async () => {
    if (api?.mobileStatus) setStatus(await api.mobileStatus());
  };
  useEffect(() => {
    void refresh().catch((e) => setError(userFacingError(e)));
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh().catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setQR('');
    if (invite)
      void QRCode.toDataURL(JSON.stringify(invite), {
        width: 320,
        margin: 4,
        errorCorrectionLevel: 'M',
      })
        .then((value) => {
          if (active) setQR(value);
        })
        .catch(() => setError('The pairing code could not be drawn. Generate a new code.'));
    return () => {
      active = false;
    };
  }, [invite]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(userFacingError(e));
    } finally {
      setBusy(false);
    }
  };
  const current = invite && invite.expiresAt > now && status.invitation?.id === invite.id;
  return (
    <><LocalPairingSettings />
    <SettingsGroup
      title="iPhone Bots"
      description="Read and send messages in existing Bots conversations on this Mac. Bots run here with their existing capabilities. Other workspace resources are not shared."
    >
      {error && (
        <SettingsRow>
          <p role="alert">{error}</p>
        </SettingsRow>
      )}
      <SettingsRow
        label="Secure sharing"
        description={
          status.enabled
            ? `Listening at ${status.endpoint}. Stops when FreeLM closes.`
            : 'Off. Requires a trusted HTTPS certificate for an address reachable by your iPhone. No router or firewall settings are changed.'
        }
      >
        {status.enabled ? (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api?.mobileStop?.();
                setInvite(undefined);
              })
            }
          >
            Stop iPhone sharing
          </button>
        ) : (
          <span>Not enabled</span>
        )}
      </SettingsRow>
      {!status.enabled && (
        <>
          <SettingsRow label="HTTPS address" htmlFor="mobile-endpoint">
            <input
              id="mobile-endpoint"
              placeholder="https://mac.example.com:4320"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              disabled={busy}
            />
          </SettingsRow>
          <SettingsRow
            label="Listen address"
            htmlFor="mobile-bind"
            description="127.0.0.1 is local-only. Choose a Mac network interface address only when you are ready to allow iPhone access."
          >
            <input
              id="mobile-bind"
              value={bindAddress}
              onChange={(e) => setBindAddress(e.target.value)}
              disabled={busy}
            />
          </SettingsRow>
          <SettingsRow description="Select your certificate chain and matching private-key PEM files. Files stay on this Mac; the private key is never placed in the QR code.">
            <button
              className="secondary-button"
              disabled={busy || !endpoint || !api?.mobileStart}
              onClick={() =>
                void act(async () => {
                  const result = await api?.mobileStart?.({ endpoint, bindAddress });
                  if (result) setStatus(result);
                })
              }
            >
              Choose certificate and enable
            </button>
          </SettingsRow>
        </>
      )}
      {status.enabled && (
        <>
          <SettingsRow
            label="Pair one iPhone"
            description="Open Bots on your iPhone and tap Connect. Scan this code only from your own Mac."
          >
            <button
              className="secondary-button"
              disabled={busy || status.sessions.length > 0 || Boolean(status.invitation)}
              onClick={() => void act(async () => setInvite(await api!.mobileInvite!()))}
            >
              Generate pairing code
            </button>
          </SettingsRow>
          {current && (
            <SettingsRow
              layout="stacked"
              label={`Code expires in ${Math.max(0, Math.ceil((invite.expiresAt - now) / 1000))} seconds`}
            >
              {qr && (
                <img
                  src={qr}
                  width={320}
                  height={320}
                  style={{ maxWidth: '100%', height: 'auto', background: 'white' }}
                  alt="Single-use iPhone Bots pairing code"
                />
              )}
              <details>
                <summary>Enter manually</summary>
                <textarea
                  readOnly
                  aria-label="Manual pairing invitation"
                  value={JSON.stringify(invite)}
                  rows={5}
                  style={{ width: '100%' }}
                />
              </details>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api!.mobileRevoke!(invite.id);
                    setInvite(undefined);
                  })
                }
              >
                Cancel code
              </button>
            </SettingsRow>
          )}
          {invite && !current && (
            <SettingsRow>
              <p>The code expired or was used. Generate a new code if needed.</p>
            </SettingsRow>
          )}
          {status.sessions.map((session) => (
            <SettingsRow
              key={session.id}
              label="Paired iPhone"
              description={`Access expires ${new Date(session.expiresAt).toLocaleString()}. Revoke to pair a different phone.`}
            >
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api!.mobileRevoke!(session.id);
                    setInvite(undefined);
                  })
                }
              >
                Revoke iPhone access
              </button>
            </SettingsRow>
          ))}
        </>
      )}
    </SettingsGroup></>
  );
}
