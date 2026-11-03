import type { ReactNode } from 'react';
import type { PluginManifest } from '../plugin-types';
import { PLUGIN_CAPABILITY_LABELS } from '../lib/plugin-manifest';
import { SettingsGroup, SettingsRow } from './SettingsList';

function InformationRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<SettingsRow className="plugin-information-row" label={label}>
			<span>{children}</span>
		</SettingsRow>
	);
}

export default function PluginManifestReview({ manifest }: { manifest: PluginManifest }) {
	const local = manifest.manifestVersion === 2 ? manifest : undefined;
	return (
		<div className="plugin-manifest-review">
			<SettingsGroup title="Information">
				<InformationRow label="Name">{manifest.name}</InformationRow>
				<InformationRow label="Author">{manifest.author || 'Not supplied'}</InformationRow>
				<InformationRow label="Plugin ID">{manifest.id}</InformationRow>
				<InformationRow label="Version">{manifest.version}</InformationRow>
				{local ? (
					<InformationRow label="Runtime">
						FreeLM Plugin SDK v{local.runtime.apiVersion}
					</InformationRow>
				) : (
					<InformationRow label="MCP service">
						{manifest.manifestVersion === 1 && manifest.mcp.url}
					</InformationRow>
				)}
				{manifest.homepage && <InformationRow label="Website">{manifest.homepage}</InformationRow>}
			</SettingsGroup>
			{local && (
				<>
					<SettingsGroup title="Permissions">
						<InformationRow label="Network access">
							{local.permissions.network.join(', ') || 'None'}
						</InformationRow>
						<InformationRow label="Storage">
							{local.permissions.storage ? 'Private storage for each account' : 'None'}
						</InformationRow>
						{local.runtime.apiVersion === 2 && (
							<InformationRow label="Surface access">
								{local.contributes.activation?.surfaces
									.map((surface) => (surface === 'home.chat' ? 'Chat' : 'Code'))
									.join(', ') || 'None'}
							</InformationRow>
						)}
					</SettingsGroup>
					{local.runtime.apiVersion === 2 && (
						<SettingsGroup
							title="Capabilities"
							description="Declared by this plugin. Review before enabling it."
						>
							{local.permissions.capabilities?.length ? (
								local.permissions.capabilities.map((capability) => (
									<SettingsRow key={capability} label={PLUGIN_CAPABILITY_LABELS[capability]} />
								))
							) : (
								<SettingsRow label="None" />
							)}
						</SettingsGroup>
					)}
					<SettingsGroup title="Tools">
						{local.contributes.tools.length ? (
							local.contributes.tools.map((tool) => (
								<SettingsRow
									key={tool.name}
									label={tool.name}
									description={`${tool.description}${tool.readOnly ? ' · Read-only hint, not a verified guarantee' : ' · May change data'}`}
								/>
							))
						) : (
							<SettingsRow label="None" />
						)}
					</SettingsGroup>
					<SettingsGroup title="Extensions">
						<InformationRow label="Tabs">
							{local.contributes.tabs.map((tab) => tab.title).join(', ') || 'None'}
						</InformationRow>
						<InformationRow label="UI actions">
							{local.contributes.actions.join(', ') || 'None'}
						</InformationRow>
					</SettingsGroup>
				</>
			)}
			<SettingsGroup title="Authorization">
				<InformationRow label="Authentication">
					{manifest.auth.type === 'oauth2' ? 'OAuth 2.0' : 'No sign-in required'}
				</InformationRow>
				{manifest.auth.type === 'oauth2' && (
					<>
						{manifest.auth.apiOrigin && (
							<InformationRow label="Authenticated API">{manifest.auth.apiOrigin}</InformationRow>
						)}
						<InformationRow label="Client ID">{manifest.auth.clientId}</InformationRow>
						<InformationRow label="Sign-in URL">{manifest.auth.authorizationUrl}</InformationRow>
						<InformationRow label="Token URL">{manifest.auth.tokenUrl}</InformationRow>
						<InformationRow label="Requested scopes">
							{manifest.auth.scopes.join(', ') || 'None'}
						</InformationRow>
						{manifest.auth.resource && (
							<InformationRow label="Resource">{manifest.auth.resource}</InformationRow>
						)}
						{manifest.auth.revocationUrl && (
							<InformationRow label="Revocation URL">{manifest.auth.revocationUrl}</InformationRow>
						)}
					</>
				)}
			</SettingsGroup>
		</div>
	);
}
