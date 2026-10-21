import type { Meta, StoryObj } from '@storybook/react-vite';
import NavigationIcon from '../../components/NavigationIcon';

const meta = {
	title: 'Navigation/Icons',
	component: NavigationIcon,
	args: { destination: 'home', selected: false },
	argTypes: {
		destination: { control: 'select', options: ['home', 'images', 'videos', 'audio', 'settings'] },
		selected: { control: 'boolean' },
	},
	parameters: {
		docs: {
			description: {
				component:
					'Actual outline and selected filled navigation icons. Edit src/components/NavigationIcon.tsx. Use Controls to choose an icon and toggle its selected state.',
			},
		},
	},
	render: (args) => (
		<button
			className={`rail-button ${args.selected ? 'active' : ''}`}
			aria-label={args.destination}
		>
			<NavigationIcon {...args} />
		</button>
	),
} satisfies Meta<typeof NavigationIcon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Outline: Story = {};
export const Selected: Story = { args: { selected: true } };
export const AllVariants: Story = {
	render: () => (
		<div style={{ display: 'grid', gap: 16 }}>
			{(['home', 'images', 'videos', 'audio', 'settings'] as const).map((destination) => (
				<div key={destination} style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
					<span style={{ width: 72, textTransform: 'capitalize' }}>{destination}</span>
					<span className="rail-button">
						<NavigationIcon destination={destination} selected={false} />
					</span>
					<span className="rail-button active">
						<NavigationIcon destination={destination} selected />
					</span>
				</div>
			))}
		</div>
	),
};
