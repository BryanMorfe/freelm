import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import WorkspaceTitlebar from '../../components/WorkspaceTitlebar';
import { connections } from './fixtures';

function TitlebarExample({
	narrow = false,
	settings = false,
}: {
	narrow?: boolean;
	settings?: boolean;
}) {
	const [panelOpen, setPanelOpen] = useState(!narrow);
	const [summaryOpen, setSummaryOpen] = useState(true);
	const [connectionId, setConnectionId] = useState(connections[0].id);
	const [notice, setNotice] = useState(
		'Toggle the sidebar, switch the preview connection, or hide the pinned summary.',
	);
	return (
		<div
			className={`app-shell ${panelOpen ? '' : 'sidebar-hidden'}`}
			style={{
				width: narrow ? 640 : 1080,
				maxWidth: '100%',
				height: 190,
				minHeight: 190,
				borderRadius: 12,
				overflow: 'hidden',
			}}
		>
			<WorkspaceTitlebar
				title={settings ? 'Settings' : 'Build a visual notebook with a responsive board layout'}
				projectName={settings ? undefined : 'Mosaic'}
				kind="code"
				conversation={!settings}
				settingsOpen={settings}
				panelOpen={panelOpen}
				pinnedSummaryAvailable
				pinnedSummaryOpen={summaryOpen}
				busy={false}
				connection={connections.find((item) => item.id === connectionId)!}
				connections={connections}
				onTogglePanel={() => setPanelOpen((value) => !value)}
				onTogglePinnedSummary={() => setSummaryOpen((value) => !value)}
				onNewChat={() => setNotice('New task selected.')}
				onSearch={() => setNotice('Search tasks selected.')}
				onConnection={setConnectionId}
			/>
			<p
				style={{
					gridColumn: '1 / -1',
					gridRow: 2,
					background: 'var(--bg)',
					margin: 0,
					padding: 24,
					color: 'var(--muted)',
				}}
				role="status"
			>
				{settings
					? 'Settings titlebar has no conversation actions.'
					: `${notice} Pinned summary: ${summaryOpen ? 'shown' : 'hidden'}.`}
			</p>
		</div>
	);
}

const meta = {
	title: 'Navigation/Titlebar',
	component: TitlebarExample,
	args: { narrow: false, settings: false },
	parameters: {
		docs: {
			description: {
				component:
					'Actual workspace titlebar, connection selector, sidebar controls, and pinned-summary toggle. Edit src/components/WorkspaceTitlebar.tsx and src/components/sidebar.css. This fixture does not load a real thread or export history.',
			},
		},
	},
	render: (args) => <TitlebarExample key={`${args.narrow}-${args.settings}`} {...args} />,
} satisfies Meta<typeof TitlebarExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const NarrowWithCollapsedSidebar: Story = { args: { narrow: true } };
export const Settings: Story = { args: { settings: true } };
