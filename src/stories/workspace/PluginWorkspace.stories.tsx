import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import PluginWorkspace from '../../components/PluginWorkspace';
import { notesManifest, notesTabHTML } from './plugin-runtime-fixtures';
import type { PluginTabChoice } from '../../components/usePluginTabs';
import type { PluginAccount, PluginBridge } from '../../plugin-types';
const choice: PluginTabChoice = {
	key: 'sample.notes/notes',
	plugin: {
		manifest: notesManifest,
		enabled: true,
		installedAt: 1,
		package: { hash: 'example', installedBytes: 4096 },
	},
	tab: notesManifest.contributes.tabs[0],
};
const accounts: PluginAccount[] = ['Personal', 'Work'].map((label, index) => ({
	id: String(index),
	pluginId: notesManifest.id,
	label,
	status: 'connected',
	tools: [],
	access: { chat: false, code: false, botIds: [], tools: [], allowRemote: false },
}));
function Preview({
	empty = false,
	failure = false,
	narrow = false,
}: {
	empty?: boolean;
	failure?: boolean;
	narrow?: boolean;
}) {
	const [notice, setNotice] = useState('');
	const [bridge] = useState<Pick<PluginBridge, 'pluginTabContent' | 'pluginInvokeAction'>>(() => ({
		pluginTabContent: async () => ({ html: notesTabHTML }),
		pluginInvokeAction: async (_plugin, _tab, accountId) => {
			if (failure) throw new Error('The example service is unavailable. Try again.');
			return { saved: true, accountId };
		},
	}));
	return (
		<div style={{ width: narrow ? 350 : 940, maxWidth: '100%', height: 660 }}>
			<PluginWorkspace
				choice={choice}
				accounts={empty ? [] : accounts}
				bridge={bridge}
				onSettings={() => setNotice('Open Settings → Plugins in the app to manage this plugin.')}
			/>
			{notice && <p role="status">{notice}</p>}
		</div>
	);
}
const meta = {
	title: 'Plugins/Workspace',
	component: Preview,
	args: { empty: false, failure: false, narrow: false },
	render: (args) => <Preview key={`${args.empty}-${args.failure}-${args.narrow}`} {...args} />,
	parameters: {
		docs: {
			description: {
				component:
					'Actual sandboxed plugin workspace and account selector. The preview uses an isolated mock bridge, so it cannot reach external services or your profile.',
			},
		},
	},
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Notebook: Story = {};
export const NoAccount: Story = { args: { empty: true } };
export const ActionError: Story = { args: { failure: true } };
export const Narrow: Story = { args: { narrow: true } };
