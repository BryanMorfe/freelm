import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import WorkspaceSplash from '../../components/WorkspaceSplash';

function AnimationStudy() {
	const preview = useRef<HTMLDivElement>(null);
	const [paused, setPaused] = useState(false);
	const [reducedMotion, setReducedMotion] = useState(false);
	const [replay, setReplay] = useState(0);
	const lastReplay = useRef(0);
	useLayoutEffect(() => {
		const restart = replay !== lastReplay.current;
		lastReplay.current = replay;
		for (const animation of preview.current?.getAnimations({ subtree: true }) ?? []) {
			if (restart) animation.currentTime = 0;
			paused ? animation.pause() : animation.play();
		}
	}, [paused, reducedMotion, replay]);
	useEffect(() => {
		const preference = matchMedia('(prefers-reduced-motion: reduce)');
		const update = () => {
			setReducedMotion(preference.matches);
			setPaused(false);
		};
		update();
		preference.addEventListener('change', update);
		return () => preference.removeEventListener('change', update);
	}, []);
	return (
		<div ref={preview}>
			<WorkspaceSplash />
			<div
				style={{
					position: 'fixed',
					inset: 'auto 20px 28px',
					display: 'grid',
					justifyItems: 'center',
					gap: 12,
					fontSize: 'var(--font-size-ui)',
				}}
			>
				<div style={{ display: 'flex', gap: 8 }}>
					<button
						className="secondary-button"
						disabled={reducedMotion}
						onClick={() => {
							setReplay((value) => value + 1);
							setPaused(false);
						}}
					>
						Replay drawing
					</button>
					<button
						className="secondary-button"
						disabled={reducedMotion}
						onClick={() => setPaused((value) => !value)}
					>
						{paused ? 'Resume animation' : 'Pause animation'}
					</button>
				</div>
				<p style={{ margin: 0, color: 'var(--muted)', textAlign: 'center' }}>
					{reducedMotion
						? 'Reduced motion is enabled. The finished logo stays still.'
						: 'The same drawing animation used while the workspace opens.'}
				</p>
			</div>
		</div>
	);
}

const meta = {
	title: 'Navigation/Workspace splash',
	component: WorkspaceSplash,
	parameters: {
		layout: 'fullscreen',
		docs: {
			description: {
				component:
					'The actual workspace loading screen, using the foreground SVG and the app theme. The logo draws itself into view and respects your operating system’s reduced-motion preference. Use Animation study to replay or pause the production animation. Edit src/components/DrawingLogo.tsx and src/components/drawing-logo.css.',
			},
		},
	},
} satisfies Meta<typeof WorkspaceSplash>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { globals: { theme: 'dark' } };
export const Light: Story = { globals: { theme: 'light' } };
export const Animation: Story = {
	name: 'Animation study',
	globals: { theme: 'dark' },
	render: () => <AnimationStudy />,
};
