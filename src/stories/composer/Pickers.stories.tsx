import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ArrowUp, Plus } from 'lucide-react';
import ChatModelPicker from '../../components/ChatModelPicker';
import CodePermissionPicker from '../../components/CodePermissionPicker';
import ComposerToolbar from '../../components/ComposerToolbar';
import type { CodePermissionMode } from '../../agent-types';
import { defaultThinkingMode } from '../../lib/catalog';
import { composerConnection } from './fixtures';

interface PickerPreviewProps {
	task: 'chat' | 'images' | 'videos';
	model: string;
	thinkingMode: string;
	permission: CodePermissionMode;
	showPermissions: boolean;
	disabled: boolean;
	readOnly: boolean;
	width: number;
}
function PickerPreview(args: PickerPreviewProps) {
	const [model, setModel] = useState(args.model);
	const [effort, setEffort] = useState(args.thinkingMode);
	const [permission, setPermission] = useState(args.permission);
	const [notice, setNotice] = useState('');
	useEffect(() => {
		setModel(args.model);
		setEffort(args.thinkingMode);
	}, [args.model, args.thinkingMode]);
	useEffect(() => setPermission(args.permission), [args.permission]);
	return (
		<div style={{ width: args.width, maxWidth: '100%', paddingTop: 220, paddingBottom: 180 }}>
			<div className="composer">
				<ComposerToolbar>
					<div className="composer-tools">
						<button
							type="button"
							className="icon-button composer-attach"
							aria-label="Attach files"
							title="Attach an image or text file"
							disabled={args.disabled}
							onClick={() => setNotice('Attachment selected. This preview does not open files.')}
						>
							<Plus size={19} />
						</button>
						{args.showPermissions && (
							<CodePermissionPicker
								value={permission}
								onChange={setPermission}
								disabled={args.disabled}
								readOnly={args.readOnly}
							/>
						)}
					</div>
					<div className="composer-actions">
						<ChatModelPicker
							connection={composerConnection}
							task={args.task}
							model={model}
							thinkingMode={effort}
							onThinkingMode={setEffort}
							disabled={args.disabled}
							onSelect={(next) => {
								setModel(next);
								setEffort(defaultThinkingMode(composerConnection, next) || '');
							}}
							onSettings={() =>
								setNotice('Settings link selected. The component gallery stays on this page.')
							}
						/>
						<button
							type="button"
							className="send-button"
							aria-label="Send message"
							title="Send message"
							disabled={args.disabled}
							onClick={() => setNotice('Send selected. This preview does not send a request.')}
						>
							<ArrowUp size={18} />
						</button>
					</div>
				</ComposerToolbar>
			</div>
			{notice && (
				<p role="status" style={{ color: 'var(--muted)' }}>
					{notice}
				</p>
			)}
		</div>
	);
}
const meta = {
	title: 'Composer/Model and permissions',
	component: PickerPreview,
	parameters: {
		docs: {
			description: {
				component:
					'Actual ChatModelPicker, CodePermissionPicker, and ComposerToolbar components. Resize with the width control to see permission labels collapse first, followed by the model and effort. The fixture catalog is local; changing a model, thinking effort, or permission has no backend effect. Open the menus to adjust their typography, spacing, states, and keyboard navigation. Styles: chat-model-picker.css, conversation-workspaces.css, and Select’s shared stylesheet.',
			},
		},
	},
	args: {
		task: 'chat',
		model: 'qwen-chat',
		thinkingMode: 'medium',
		permission: 'auto-review',
		showPermissions: true,
		disabled: false,
		readOnly: false,
		width: 760,
	},
	argTypes: {
		task: { control: 'select', options: ['chat', 'images', 'videos'] },
		model: {
			control: 'select',
			options: ['', 'qwen-chat', 'small-chat', 'unconfigured-chat', 'qwen-image', 'video-model'],
		},
		thinkingMode: { control: 'select', options: ['', 'low', 'medium', 'high', 'max'] },
		permission: { control: 'select', options: ['ask', 'auto-review', 'full-access'] },
		width: { control: { type: 'range', min: 200, max: 760, step: 10 } },
	},
} satisfies Meta<typeof PickerPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Code: Story = {};
export const Narrow: Story = { args: { width: 400 } };
export const VeryNarrow: Story = { args: { width: 220 } };
export const Chat: Story = { args: { showPermissions: false } };
export const MaximumThinking: Story = { args: { thinkingMode: 'max' } };
export const NeedsThinkingConfiguration: Story = {
	args: { model: 'unconfigured-chat', thinkingMode: '' },
};
export const NoModelSelected: Story = { args: { model: '', thinkingMode: '' } };
export const ImageModel: Story = {
	args: { task: 'images', model: 'qwen-image', thinkingMode: '', showPermissions: false },
};
export const VideoModel: Story = {
	args: { task: 'videos', model: 'video-model', thinkingMode: '', showPermissions: false },
};
export const ReadOnlyPermissions: Story = { args: { readOnly: true } };
export const Disabled: Story = { args: { disabled: true } };
export const ThinkingMenuOpen: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole('button', { name: 'Chat model' }));
		await expect(
			within(canvasElement.ownerDocument.body).getByRole('slider', { name: 'Thinking mode' }),
		).toBeVisible();
	},
};
export const ModelListOpen: Story = {
	play: async ({ canvasElement }) => {
		const page = within(canvasElement.ownerDocument.body);
		await userEvent.click(within(canvasElement).getByRole('button', { name: 'Chat model' }));
		await userEvent.click(page.getByRole('button', { name: 'More models' }));
		await expect(page.getByRole('listbox', { name: 'Model choices' })).toBeVisible();
	},
};
export const PermissionsMenuOpen: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole('combobox', { name: 'Code permissions' }),
		);
		await expect(
			within(canvasElement.ownerDocument.body).getByRole('option', { name: /Approve for me/ }),
		).toBeVisible();
	},
};
