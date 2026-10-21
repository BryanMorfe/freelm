import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { SettingsGroup, SettingsRow } from '../../components/SettingsList';
import Select from '../../components/Select';
import Switch from '../../components/Switch';

function SettingsExample({
	narrow = false,
	disabled = false,
}: {
	narrow?: boolean;
	disabled?: boolean;
}) {
	const [notifications, setNotifications] = useState(true);
	const [debug, setDebug] = useState(false);
	const [language, setLanguage] = useState('auto');
	const [path, setPath] = useState('~/Documents/FreeLM');
	const [prompt, setPrompt] = useState(
		'Be clear and direct. Use examples when they help explain an unfamiliar idea.',
	);
	const [notice, setNotice] = useState(
		'Changes in this preview stay here and reset when the story reloads.',
	);
	return (
		<div
			className="settings-page"
			style={{ display: 'block', height: 'auto', width: narrow ? 340 : 840, maxWidth: '100%' }}
		>
			<div className="settings-section-content">
				<SettingsGroup
					title="General"
					description="A divided list with controls, explanatory text, and optional actions."
					footer={notice}
				>
					<SettingsRow
						label="Background notifications"
						description="Notify you when a response finishes while you are in another app."
					>
						<Switch
							aria-label="Background notifications"
							checked={notifications}
							onChange={setNotifications}
							disabled={disabled}
						/>
					</SettingsRow>
					<SettingsRow
						label="Language"
						description="Language used for the app interface."
						htmlFor="story-language"
					>
						<Select
							id="story-language"
							value={language}
							onChange={setLanguage}
							disabled={disabled}
							options={[
								{ value: 'auto', label: 'Auto detect' },
								{ value: 'en', label: 'English' },
								{ value: 'es', label: 'Español' },
							]}
						/>
					</SettingsRow>
					<SettingsRow
						label="Projectless task folder"
						description="Where new tasks store files when they are not attached to a project."
						htmlFor="story-project-folder"
					>
						<input
							id="story-project-folder"
							value={path}
							onChange={(event) => setPath(event.target.value)}
							disabled={disabled}
						/>
					</SettingsRow>
					<SettingsRow label="Debug mode" description="Show additional request and tool details.">
						<Switch
							aria-label="Debug mode"
							checked={debug}
							onChange={setDebug}
							disabled={disabled}
						/>
					</SettingsRow>
				</SettingsGroup>
				<SettingsGroup
					title="Instructions"
					actions={
						<button
							className="secondary-button compact"
							disabled={disabled}
							onClick={() => {
								setPrompt('');
								setNotice('Instructions cleared in this preview.');
							}}
						>
							<Plus size={14} /> New draft
						</button>
					}
					footer="Longer controls use the same stacked row layout as the application."
				>
					<SettingsRow
						label="Custom instructions"
						description="Describe how you would like the assistant to respond."
						layout="stacked"
						htmlFor="story-instructions"
					>
						<textarea
							id="story-instructions"
							rows={4}
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							disabled={disabled}
						/>
					</SettingsRow>
				</SettingsGroup>
			</div>
		</div>
	);
}

const meta = {
	title: 'Settings/Grouped lists',
	component: SettingsExample,
	args: { narrow: false, disabled: false },
	parameters: {
		docs: {
			description: {
				component:
					'Actual SettingsGroup and SettingsRow components, with the production Select and Switch controls. Edit src/components/SettingsList.tsx and src/components/settings-list.css; form styles come from src/styles.css and src/components/settings.css. Every change is local to this preview.',
			},
		},
	},
	render: (args) => <SettingsExample {...args} />,
} satisfies Meta<typeof SettingsExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const Narrow: Story = { args: { narrow: true } };
export const Disabled: Story = { args: { disabled: true } };
