import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import PluginSettings from '../../components/PluginSettings';
import { notesManifest } from './plugin-runtime-fixtures';
import type { PluginBridge, PluginManifest, PluginSnapshot } from '../../plugin-types';
import followUpSource from '../../../examples/plugins/follow-up/manifest.json';
import { defaultPluginSettings, validatePluginManifest } from '../../lib/plugin-manifest';

const examplePluginManifest: PluginManifest = {
	manifestVersion: 1,
	id: 'example.mail',
	name: 'Example Mail',
	version: '1.0.0',
	description: 'A sample service for exploring account and tool permissions.',
	author: 'Example team',
	mcp: { url: 'https://mail.example.com/mcp' },
	auth: {
		type: 'oauth2',
		clientId: 'freelm-desktop-example',
		authorizationUrl: 'https://mail.example.com/oauth/authorize',
		tokenUrl: 'https://mail.example.com/oauth/token',
		scopes: ['mail.read', 'mail.drafts'],
	},
};
const tools = [
	{ name: 'search_mail', description: 'Search the connected mailbox.', readOnly: true },
	{
		name: 'create_draft',
		description: 'Create a draft message in the connected account.',
		readOnly: false,
	},
];
const access = () => ({ chat: false, code: false, botIds: [], tools: [], allowRemote: false });
function previewBridge(mode: string): PluginBridge {
	const local = mode === 'package';
	const surface = ['surface', 'surface-error', 'surface-model-unavailable'].includes(mode);
	const selectedManifest = surface
		? validatePluginManifest(followUpSource)
		: local
			? notesManifest
			: examplePluginManifest;
	let snapshot: PluginSnapshot = {
		plugins:
			mode === 'empty'
				? []
				: [
						{
							manifest: selectedManifest,
							enabled: true,
							installedAt: 1,
							...(local ? { package: { hash: 'preview', installedBytes: 1000 } } : {}),
							...(surface
								? {
										settings: {
											...defaultPluginSettings(selectedManifest),
											...(mode === 'surface-model-unavailable'
												? {
														model: {
															source: 'configured' as const,
															hostId: 'local',
															connectionId: 'removed',
															modelId: 'removed-model',
															thinkingModeId: 'high',
														},
													}
												: {}),
										},
										surfaceAccess: { chat: true, code: true },
									}
								: {}),
							...(mode === 'surface-error'
								? {
										runtimeError:
											'The selected inference connection is unavailable. Update this plugin’s Model setting and try again.',
									}
								: {}),
						},
					],
		accounts:
			mode === 'empty' || surface
				? []
				: [
						{
							id: 'personal',
							pluginId: selectedManifest.id,
							label: 'Personal',
							status: mode === 'reconnect' ? 'reconnect' : 'connected',
							tools,
							access: access(),
							...(mode === 'reconnect'
								? { error: 'Sign-in expired. Reconnect this account to continue.' }
								: {}),
						},
					],
	};
	let cancel: (() => void) | undefined;
	return {
		pluginSnapshot: async () => structuredClone(snapshot),
		pluginPreparePackage: async () => ({
			reviewId: 'preview',
			manifest: notesManifest,
			files: 3,
			bytes: 1000,
		}),
		pluginInstallPackage: async () => {
			snapshot.plugins = [
				...snapshot.plugins.filter((plugin) => plugin.manifest.id !== notesManifest.id),
				{
					manifest: notesManifest,
					enabled: false,
					installedAt: Date.now(),
					package: { hash: 'preview', installedBytes: 1000 },
				},
			];
			return structuredClone(snapshot);
		},
		pluginCancelConnect: async () => cancel?.(),
		pluginCommand: async (command) => {
			switch (command.type) {
				case 'install': {
					const manifest = command.manifest as PluginManifest;
					snapshot.plugins = [
						...snapshot.plugins.filter((plugin) => plugin.manifest.id !== manifest.id),
						{ manifest, enabled: false, installedAt: Date.now() },
					];
					break;
				}
				case 'enable':
					snapshot.plugins = snapshot.plugins.map((plugin) =>
						plugin.manifest.id === command.pluginId
							? { ...plugin, enabled: command.enabled }
							: plugin,
					);
					break;
				case 'settings':
					snapshot.plugins = snapshot.plugins.map((plugin) =>
						plugin.manifest.id === command.pluginId
							? { ...plugin, settings: command.values }
							: plugin,
					);
					break;
				case 'surface-access':
					snapshot.plugins = snapshot.plugins.map((plugin) =>
						plugin.manifest.id === command.pluginId
							? { ...plugin, surfaceAccess: command.surfaceAccess }
							: plugin,
					);
					break;
				case 'remove':
					snapshot.plugins = snapshot.plugins.filter(
						(plugin) => plugin.manifest.id !== command.pluginId,
					);
					snapshot.accounts = snapshot.accounts.filter(
						(account) => account.pluginId !== command.pluginId,
					);
					break;
				case 'disconnect':
					snapshot.accounts = snapshot.accounts.filter(
						(account) => account.id !== command.accountId,
					);
					break;
				case 'access':
					snapshot.accounts = snapshot.accounts.map((account) =>
						account.id === command.accountId ? { ...account, access: command.access } : account,
					);
					break;
				case 'discover':
					snapshot.accounts = snapshot.accounts.map((account) =>
						account.id === command.accountId ? { ...account, tools } : account,
					);
					break;
				case 'connect':
					if (mode === 'connecting')
						await new Promise<void>((_resolve, reject) => {
							cancel = () => reject(new Error('Sign-in cancelled.'));
						});
					snapshot.accounts = [
						...snapshot.accounts.filter((account) => account.id !== command.accountId),
						{
							id: command.accountId || crypto.randomUUID(),
							pluginId: command.pluginId,
							label: command.label,
							status: 'connected',
							access: access(),
							tools,
						},
					];
			}
			return structuredClone(snapshot);
		},
	};
}
function Preview({ mode = 'connected', narrow = false }: { mode?: string; narrow?: boolean }) {
	const [bridge] = useState(() => previewBridge(mode));
	return (
		<div
			className="settings-page"
			style={{ display: 'block', height: 'auto', width: narrow ? 340 : 840, maxWidth: '100%' }}
		>
			<PluginSettings
				bridge={bridge}
				readOnly={mode === 'remote'}
				workspaceName="Workstation"
				bots={[{ id: 'nova', name: 'Nova', address: 'nova@freelm' }]}
			/>
		</div>
	);
}
const meta = {
	title: 'Settings/Plugins',
	component: Preview,
	args: { mode: 'connected', narrow: false },
	parameters: {
		docs: {
			description: {
				component:
					'Real plugin settings with an isolated in-memory bridge. No sign-in, provider calls, or profile changes. Use the theme toolbar for light/dark. Install, disconnect, and permission changes only affect this preview.',
			},
		},
	},
	render: (args) => <Preview key={`${args.mode}-${args.narrow}`} {...args} />,
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const Empty: Story = { args: { mode: 'empty' } };
export const Reconnect: Story = { args: { mode: 'reconnect' } };
export const SignInCancellation: Story = { args: { mode: 'connecting' } };
export const Remote: Story = { args: { mode: 'remote' } };
export const Narrow: Story = { args: { narrow: true } };

export const LocalPackage: Story = { args: { mode: 'package' } };
export const ComposerExtension: Story = { args: { mode: 'surface' } };
export const ComposerExtensionNarrow: Story = { args: { mode: 'surface', narrow: true } };
export const ComposerExtensionLight: Story = {
	args: { mode: 'surface' },
	globals: { theme: 'light' },
};
export const ComposerExtensionError: Story = { args: { mode: 'surface-error' } };
export const UnavailableModel: Story = { args: { mode: 'surface-model-unavailable' } };
