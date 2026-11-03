import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsGroup, SettingsRow } from '../components/SettingsList';

const meta = {
	title: 'Start here/Live editing',
	parameters: { controls: { disable: true } },
	tags: ['!autodocs'],
} satisfies Meta;
export default meta;

export const Welcome: StoryObj = {
	render: () => (
		<main className="freelm-story-guide settings-fields">
			<h1>FreeLM components</h1>
			<p>
				Edit a component or its CSS, save the file, and watch it update here. These are the app’s
				actual components, populated with sample data.
			</p>
			<SettingsGroup title="Your editing loop">
				<SettingsRow
					label="1. Choose a component"
					description="Browse the sidebar or search by name. Each story is a useful state: empty, streaming, completed, failed, expanded, or long content."
				/>
				<SettingsRow
					label="2. Make a source change"
					description={
						<span>
							Edit <code>src/components/ComponentName.tsx</code> or its CSS. Shared tokens and app
							styles live in <code>src/styles.css</code>. Saving triggers live reload.
						</span>
					}
				/>
				<SettingsRow
					label="3. Check the variations"
					description="Use the Theme and Accent menus in the top toolbar. The viewport tool checks narrow, compact, and desktop widths. Controls below the canvas change example props."
				/>
				<SettingsRow
					label="4. Keep what you like"
					description="Source edits change FreeLM itself. Storybook Controls and browser inspector tweaks are previews; they do not automatically write changes into the component."
				/>
			</SettingsGroup>
			<SettingsGroup title="Where to work">
				<SettingsRow
					label="Shared appearance"
					description={
						<code>src/styles.css · src/components/controls.css · docs/UI_GUIDELINES.md</code>
					}
				/>
				<SettingsRow
					label="Component source and styles"
					description={<code>src/components/</code>}
				/>
				<SettingsRow label="Examples and sample states" description={<code>src/stories/</code>} />
				<SettingsRow
					label="Restart the gallery"
					description={<code>cd ~/freelm/freelm &amp;&amp; npm run storybook</code>}
				/>
			</SettingsGroup>
			<SettingsGroup
				title="About this preview"
				footer="Keep primary labels and controls at least 13px, using var(--font-size-ui)."
			>
				<SettingsRow
					label="Interactive sample data"
					description="Selections, drafts, and edits are local to the stories. No API connection or real workspace is loaded. Native computer use, file dialogs, and provider requests still need to be checked in the desktop app."
				/>
			</SettingsGroup>
		</main>
	),
};
