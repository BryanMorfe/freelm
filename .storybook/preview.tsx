import { useLayoutEffect, type ReactNode } from 'react';
import type { Preview } from '@storybook/react-vite';
import { themes } from 'storybook/theming';
import { resolveAppearance } from '../src/lib/appearance';
import type { AppearanceAccent } from '../src/types';
import '../src/styles.css';
import '../src/components/sidebar.css';
import '../src/components/workspace.css';
import '../src/components/settings.css';
import '../src/components/conversation-workspaces.css';
import './preview.css';

function AppTheme({
	children,
	theme,
	accent,
}: {
	children: ReactNode;
	theme: 'light' | 'dark';
	accent: AppearanceAccent;
}) {
	useLayoutEffect(() => {
		const root = document.documentElement;
		// The app shell owns surface tokens; put that context on the preview body
		// so body-portaled menus and dialogs inherit it as well as inline stories.
		document.body.classList.add('app-shell', 'freelm-story-document');
		const colors = resolveAppearance({ accent, customAccent: '#2563eb' }, theme);
		root.dataset.theme = theme;
		root.style.setProperty('--user-bubble', colors.bubble);
		root.style.setProperty('--on-user-bubble', colors.bubbleText);
		root.style.setProperty('--primary', colors.primary);
		root.style.setProperty('--on-primary', colors.onPrimary);
	}, [theme, accent]);
	return <div className="freelm-story">{children}</div>;
}

const preview: Preview = {
	tags: ['autodocs'],
	globalTypes: {
		theme: {
			description: 'FreeLM appearance',
			toolbar: {
				title: 'Theme',
				icon: 'circlehollow',
				dynamicTitle: true,
				items: [
					{ value: 'dark', title: 'Dark' },
					{ value: 'light', title: 'Light' },
				],
			},
		},
		accent: {
			description: 'FreeLM accent color',
			toolbar: {
				title: 'Accent',
				icon: 'paintbrush',
				dynamicTitle: true,
				items: [
					{ value: 'default', title: 'Default accent' },
					{ value: 'blue', title: 'Blue accent' },
					{ value: 'purple', title: 'Purple accent' },
				],
			},
		},
	},
	initialGlobals: { theme: 'dark', accent: 'default' },
	decorators: [
		(Story, context) => (
			<AppTheme
				theme={context.globals.theme === 'light' ? 'light' : 'dark'}
				accent={context.globals.accent ?? 'default'}
			>
				<Story />
			</AppTheme>
		),
	],
	parameters: {
		layout: 'padded',
		backgrounds: { disable: true },
		controls: { expanded: true },
		docs: { theme: themes.dark, codePanel: true },
		viewport: {
			options: {
				phone: { name: 'Narrow · 390px', styles: { width: '390px', height: '844px' } },
				compact: { name: 'Compact · 768px', styles: { width: '768px', height: '900px' } },
				desktop: { name: 'Desktop · 1440px', styles: { width: '1440px', height: '900px' } },
			},
		},
		options: {
			storySort: {
				order: [
					'Start here',
					'Controls',
					'Settings',
					'Navigation',
					'Composer',
					'Conversation',
					'Summaries',
					'Media',
				],
			},
		},
	},
};

export default preview;
