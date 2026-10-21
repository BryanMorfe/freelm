import { AudioLines, Bot, House, Image, Settings, Video, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';

type NavigationDestination =
	'home' | 'bots' | 'workflows' | 'images' | 'videos' | 'audio' | 'settings';

const outlineIcons = {
	home: House,
	bots: Bot,
	workflows: Workflow,
	images: Image,
	videos: Video,
	audio: AudioLines,
	settings: Settings,
};

// Closed silhouettes keep the interior details transparent rather than filling
// Lucide's open strokes (which would obscure the door, landscape, and gear hole).
const filledIcons: Record<NavigationDestination, ReactNode> = {
	workflows: (
		<>
			<rect x="2" y="2" width="7" height="7" rx="2" />
			<rect x="15" y="15" width="7" height="7" rx="2" />
			<path d="M4.5 9h2v7a1.5 1.5 0 0 0 1.5 1.5h7v2H8A3.5 3.5 0 0 1 4.5 16Z" />
		</>
	),
	bots: (
		<path
			fillRule="evenodd"
			d="M11 2h2v3h4a4 4 0 0 1 4 4v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a4 4 0 0 1 4-4h4V2ZM8 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-8 6v2h8v-2H8Z"
		/>
	),
	home: (
		<path d="M10.7 2.5a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2h-4v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 .7-1.5z" />
	),
	images: (
		<path
			fillRule="evenodd"
			d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm4 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-4 12h14v-3l-4-4-5 5-2-2-3 3v1Z"
		/>
	),
	videos: (
		<>
			<rect x="2" y="5" width="14" height="14" rx="2" />
			<path d="M18 9.5 21.4 7a1 1 0 0 1 1.6.8v8.4a1 1 0 0 1-1.6.8L18 14.5z" />
		</>
	),
	audio: (
		<>
			<rect x="1" y="9" width="2.5" height="6" rx="1.25" />
			<rect x="4.9" y="5" width="2.5" height="14" rx="1.25" />
			<rect x="8.8" y="2" width="2.5" height="20" rx="1.25" />
			<rect x="12.7" y="8" width="2.5" height="8" rx="1.25" />
			<rect x="16.6" y="5" width="2.5" height="14" rx="1.25" />
			<rect x="20.5" y="9" width="2.5" height="6" rx="1.25" />
		</>
	),
	settings: (
		<path
			fillRule="evenodd"
			d="m9 2-.5 2.5-1.7 1L4.4 5 2 9l1.9 1.7v2.6L2 15l2.4 4 2.4-.5 1.7 1L9 22h6l.5-2.5 1.7-1 2.4.5 2.4-4-1.9-1.7v-2.6L22 9l-2.4-4-2.4.5-1.7-1L15 2H9Zm3 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
		/>
	),
};

export default function NavigationIcon({
	destination,
	selected,
}: {
	destination: NavigationDestination;
	selected: boolean;
}) {
	const OutlineIcon = outlineIcons[destination];
	if (!selected) return <OutlineIcon size={19} aria-hidden="true" data-variant="outline" />;
	return (
		<svg
			width="19"
			height="19"
			viewBox="0 0 24 24"
			fill="currentColor"
			stroke="none"
			aria-hidden="true"
			data-variant="filled"
		>
			{filledIcons[destination]}
		</svg>
	);
}
