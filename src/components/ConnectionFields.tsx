import { useEffect, useId, useState } from 'react';
import type { PluginSnapshot } from '../plugin-types';
import type { Connection } from '../types';
import { SettingsRow } from './SettingsList';
import Select from './Select';
export default function ConnectionFields({
  connection,
  updateConnection,
  remote = false,
  secureStorage,
  secureStorageChecked = true,
}: {
  connection: Connection;
  updateConnection: (patch: Partial<Connection>) => void;
  remote?: boolean;
  secureStorage: boolean;
  secureStorageChecked?: boolean;
}) {
  const fieldId = useId();
  const [snapshot, setSnapshot] = useState<PluginSnapshot>({ plugins: [], accounts: [] });
  const [snapshotStatus, setSnapshotStatus] = useState('Loading provider adapters…');
  useEffect(() => {
    if (remote) return;
    let current = true;
    const refresh = () => {
      if (!window.desktop?.pluginSnapshot) {
        setSnapshotStatus('Provider adapters are available in the desktop app.');
        return;
      }
      void window.desktop
        .pluginSnapshot()
        .then((next) => {
          if (current) {
            setSnapshot(next);
            setSnapshotStatus('');
          }
        })
        .catch(() => {
          if (current)
            setSnapshotStatus('Could not load provider adapters. Reopen Settings to try again.');
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.removeEventListener('focus', refresh);
    };
  }, [remote]);
  const binding = connection.providerAdapter;
  const bindingKey = (value: { pluginId: string; providerId: string; accountId: string }) =>
    JSON.stringify([value.pluginId, value.providerId, value.accountId]);
  const adapters = snapshot.plugins.flatMap((plugin) => {
    if (!plugin.enabled || plugin.manifest.manifestVersion !== 2) return [];
    return (plugin.manifest.contributes.providers ?? []).flatMap((provider) =>
      snapshot.accounts
        .filter(
          (account) => account.pluginId === plugin.manifest.id && account.status === 'connected',
        )
        .map((account) => ({
          value: bindingKey({
            pluginId: plugin.manifest.id,
            providerId: provider.id,
            accountId: account.id,
          }),
          label: `${plugin.manifest.name} · ${provider.name} · ${account.label}`,
          binding: { pluginId: plugin.manifest.id, providerId: provider.id, accountId: account.id },
        })),
    );
  });
  const selectedAdapter = binding ? bindingKey(binding) : '';
  const missingAdapter =
    !!binding && !adapters.some((adapter) => adapter.value === selectedAdapter);
  return (
    <>
      <SettingsRow label="Connection name" htmlFor={`${fieldId}-name`}>
        <input
          id={`${fieldId}-name`}
          readOnly={remote}
          value={connection.name}
          onChange={(e) => updateConnection({ name: e.target.value })}
          placeholder="My provider"
        />
      </SettingsRow>
      <SettingsRow
        label="API base URL"
        htmlFor={`${fieldId}-url`}
        description="Include the API prefix, usually /v1."
      >
        <input
          readOnly={remote}
          type="url"
          id={`${fieldId}-url`}
          value={connection.baseUrl}
          onChange={(e) => updateConnection({ baseUrl: e.target.value })}
          placeholder="http://localhost:8000/v1"
        />
      </SettingsRow>
      {!remote && (
        <SettingsRow
          label={
            <>
              API key <span className="optional">optional</span>
            </>
          }
          htmlFor={`${fieldId}-key`}
          description={
            secureStorage
              ? 'Encrypted with your operating system’s secret storage.'
              : secureStorageChecked
                ? 'Kept in memory for this session. Secure key storage is unavailable.'
                : 'System secret storage is checked when saving an API key.'
          }
        >
          <input
            id={`${fieldId}-key`}
            type="password"
            autoComplete="off"
            value={connection.apiKey}
            onChange={(e) => updateConnection({ apiKey: e.target.value })}
            placeholder="Not required for most local servers"
          />
        </SettingsRow>
      )}
      <SettingsRow
        label="Provider protocol"
        description="Use a built-in protocol or an installed plugin’s connected account. Adapters are experimental and support text and tools only. Configure model IDs manually in Models and use Standard thinking. In Plugins, enable account access for Chat, Code, or individual Bots; selecting an adapter does not grant access."
      >
        <Select
          aria-label="Provider protocol"
          disabled={remote}
          value={selectedAdapter || 'builtin'}
          options={[
            { value: 'builtin', label: 'Built-in OpenAI-compatible API' },
            ...adapters,
            ...(missingAdapter
              ? [
                  {
                    value: selectedAdapter,
                    label: `Unavailable: ${binding!.pluginId} · ${binding!.providerId} · ${binding!.accountId}`,
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={(value) => {
            if (value === 'builtin') {
              updateConnection({ providerAdapter: undefined });
              return;
            }
            const adapter = adapters.find((item) => item.value === value);
            if (adapter)
              updateConnection({
                providerAdapter: { ...adapter.binding, credentialHeader: 'authorization' },
                chatApi: 'chat/completions',
              });
          }}
        />
      </SettingsRow>
      {!remote && (snapshotStatus || missingAdapter) && (
        <SettingsRow
          label="Adapter status"
          description={
            snapshotStatus ||
            'The selected plugin or connected account is unavailable. Enable or reconnect it in Plugins, or explicitly select another protocol. This connection will not fall back to a built-in protocol.'
          }
        />
      )}
      {binding ? (
        <SettingsRow
          label="Credential header"
          description="The host adds the connection’s API key to this header; the plugin does not receive the key."
        >
          <Select
            aria-label="Credential header"
            disabled={remote}
            value={binding.credentialHeader}
            options={[
              { value: 'authorization', label: 'Authorization (Bearer)' },
              { value: 'x-api-key', label: 'x-api-key' },
            ]}
            onChange={(value) =>
              updateConnection({
                providerAdapter: {
                  ...binding,
                  credentialHeader: value as 'authorization' | 'x-api-key',
                },
              })
            }
          />
        </SettingsRow>
      ) : (
        <SettingsRow
          label="Chat endpoint"
          description="Use /chat/completions for providers that do not support the OpenAI Responses API."
        >
          <Select
            aria-label="Chat endpoint"
            disabled={remote}
            value={connection.chatApi}
            onChange={(chatApi) => updateConnection({ chatApi: chatApi as Connection['chatApi'] })}
            options={[
              { value: 'responses', label: '/responses' },
              { value: 'chat/completions', label: '/chat/completions' },
              { value: 'chat', label: '/chat (compatible alias)' },
            ]}
          />
        </SettingsRow>
      )}
    </>
  );
}
