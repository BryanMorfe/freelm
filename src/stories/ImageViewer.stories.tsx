import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import ImageViewer from '../components/ImageViewer';
import type { Attachment } from '../types';

// Self-contained fixture: no remote media or image-generation request.
const dataUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#91b8aa"/><stop offset="1" stop-color="#254159"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="880" cy="220" r="100" fill="#f5deb2"/><path d="M0 800V520L280 280 570 620 820 400 1200 710V800" fill="#172f40"/><path d="M0 800V680L230 520 450 700 700 500 1200 760V800" fill="#3f6c6b"/></svg>')}`;
const source: Attachment = { name: 'storybook-landscape.svg', type: 'image/svg+xml', dataUrl };

function ViewerExample({
	loading = false,
	failed = false,
	busy = false,
	readOnly = false,
	warning = false,
}: {
	loading?: boolean;
	failed?: boolean;
	busy?: boolean;
	readOnly?: boolean;
	warning?: boolean;
}) {
	const [open, setOpen] = useState(true);
	const [index, setIndex] = useState(0);
	const [notice, setNotice] = useState('');
	return (
		<>
			<button className="secondary" onClick={() => setOpen(true)}>
				Open image viewer
			</button>
			{notice && <p role="status">{notice}</p>}
			{open && (
				<ImageViewer
					asset={{ name: source.name, mimeType: source.type, url: dataUrl }}
					source={loading || failed ? null : source}
					loading={loading}
					busy={busy}
					readOnly={readOnly}
					error={failed ? 'This sample image could not be loaded.' : undefined}
					moderationWarnings={
						warning ? ['Preview warning: an evaluator is not configured.'] : undefined
					}
					prompt="A quiet mountain landscape with a warm evening sun."
					modelLabel="Example image model"
					modelPicker={<span>Example image model</span>}
					index={index}
					total={3}
					onPrevious={() => setIndex((value) => Math.max(0, value - 1))}
					onNext={() => setIndex((value) => Math.min(2, value + 1))}
					onClose={() => setOpen(false)}
					onStop={() => setNotice('Stop clicked in the preview.')}
					onRetryLoad={() => setNotice('Retry clicked in the preview.')}
					onEdit={(prompt, options) =>
						setNotice(`Preview edit: ${prompt}${options?.size ? ` · ${options.size}` : ''}`)
					}
				/>
			)}
		</>
	);
}

const meta = {
	title: 'Media/Image viewer',
	component: ViewerExample,
	tags: ['!autodocs'],
	parameters: {
		layout: 'fullscreen',
		docs: {
			description: {
				component:
					'Source: src/components/ImageViewer.tsx · Styles: src/components/image-viewer.css. Actual fit/zoom, editing selection, size, full-screen, and close controls. Uses a local SVG fixture; edit actions only update preview text. These full-screen stories are excluded from inline Docs to avoid overlapping dialogs.',
			},
		},
	},
	args: { loading: false, failed: false, busy: false, readOnly: false, warning: false },
} satisfies Meta<typeof ViewerExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const ReadOnly: Story = { args: { readOnly: true } };
export const Loading: Story = { args: { loading: true } };
export const LoadFailed: Story = { args: { failed: true } };
export const Editing: Story = { args: { busy: true } };
export const ModerationWarning: Story = { args: { warning: true } };
