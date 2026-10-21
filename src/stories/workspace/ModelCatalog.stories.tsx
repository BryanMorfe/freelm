import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import ModelCatalogEditor from '../../components/ModelCatalogEditor';
import type { Connection, ModelDefinition } from '../../types';
import { connection, modelCatalog, thinkingModes } from './fixtures';

function CatalogExample({
	empty = false,
	readOnly = false,
	narrow = false,
}: {
	empty?: boolean;
	readOnly?: boolean;
	narrow?: boolean;
}) {
	const [catalog, setCatalog] = useState<ModelDefinition[]>(() =>
		empty ? [] : structuredClone(modelCatalog),
	);
	const [defaults, setDefaults] = useState<Connection['models']>(() =>
		empty
			? { chat: '', images: '', videos: '', speech: '', transcription: '' }
			: { ...connection.models },
	);
	const [editing, setEditing] = useState(false);
	return (
		<div
			className="settings-page"
			style={{ display: 'block', height: 'auto', width: narrow ? 380 : 900, maxWidth: '100%' }}
		>
			<div className="settings-section-content">
				<ModelCatalogEditor
					catalog={catalog}
					discoveredModels={empty ? [] : ['example-unconfigured']}
					models={defaults}
					chatApi="responses"
					thinkingPresets={thinkingModes}
					readOnly={readOnly}
					onChange={setCatalog}
					onDefaultsChange={setDefaults}
					onEditingChange={setEditing}
				/>
				<p className="settings-note" role="status">
					{editing
						? 'Editing a preview model. Apply or cancel to return to the list.'
						: 'Preview catalog only. Edit, add, remove, and filter models without changing your saved settings.'}
				</p>
			</div>
		</div>
	);
}

const meta = {
	title: 'Settings/Model catalog',
	component: CatalogExample,
	args: { empty: false, readOnly: false, narrow: false },
	parameters: {
		docs: {
			description: {
				component:
					'Actual grouped model catalog and its interactive editors, including thinking modes, context windows, modalities, defaults, and image resolution presets. Edit src/components/ModelCatalogEditor.tsx, src/components/ImagePresetsEditor.tsx, and src/components/model-catalog.css. The synthetic catalog has Chat & Code, Image, Video, Audio, Unknown, and disabled model examples. No discovery or provider request is made.',
			},
		},
	},
	render: (args) => <CatalogExample key={String(args.empty)} {...args} />,
} satisfies Meta<typeof CatalogExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ConfiguredModels: Story = {};
export const Empty: Story = { args: { empty: true } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Narrow: Story = { args: { narrow: true } };
export const ChatModelEditor: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole('button', { name: 'Edit model Example reasoning model' }),
		);
	},
};
export const ImageModelEditor: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole('button', { name: 'Edit model Example image model' }),
		);
	},
};
export const NewModelEditor: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole('button', { name: 'Add model' }));
	},
};
