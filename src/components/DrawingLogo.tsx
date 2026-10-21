import { useId, useMemo } from 'react';
import foregroundLogo from '../../resources/branding/logo-foreground.svg?raw';
import './drawing-logo.css';

const ribbons = [
	// One continuous stroke rises through the stem and curves into the top arm.
	// Both canonical surfaces share its mask so there is no second start or pause.
	{
		name: 'stem-top',
		sources: ['stem', 'top-ribbon'],
		path: 'M466.5 1140V535C466.5 425 477 363 588 363H1100',
	},
	{
		name: 'middle',
		sources: ['middle-ribbon'],
		path: 'M366 1125C366 815 440 642 638 642H1030',
	},
] as const;

export default function DrawingLogo() {
	const id = `freelm-logo-${useId().replace(/:/g, '')}`;
	// This is our bundled SVG, never user content. Namespace its definitions so
	// multiple previews can share the canonical artwork without ID collisions.
	const source = useMemo(
		() =>
			foregroundLogo
				.replace(/\bid="([^"]+)"/g, (_, name: string) => `id="${id}-${name}"`)
				.replace(/(url\(#|href="#)([^)"]+)/g, '$1' + id + '-$2')
				.replace(
					/aria-labelledby="([^"]+)"/g,
					(_, names: string) =>
						`aria-labelledby="${names
							.split(' ')
							.map((name) => `${id}-${name}`)
							.join(' ')}"`,
				),
		[id],
	);
	return (
		<div className="drawing-logo" aria-hidden="true">
			<div className="drawing-logo-source" dangerouslySetInnerHTML={{ __html: source }} />
			<svg className="drawing-logo-art" viewBox="0 0 1254 1254" fill="none" focusable="false">
				<defs>
					{ribbons.map((ribbon) => (
						<mask
							id={`${id}-draw-${ribbon.name}`}
							key={ribbon.name}
							maskUnits="userSpaceOnUse"
							x="0"
							y="0"
							width="1254"
							height="1254"
						>
							<path
								className={`drawing-logo-ink drawing-logo-ink--${ribbon.name}`}
								d={ribbon.path}
								pathLength="1"
								stroke="white"
								strokeWidth="210"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</mask>
					))}
				</defs>
				{ribbons.map((ribbon) => (
					<g
						className="drawing-logo-part"
						mask={`url(#${id}-draw-${ribbon.name})`}
						key={ribbon.name}
					>
						{ribbon.sources.map((source) => (
							<use key={source} href={`#${id}-${source}`} />
						))}
					</g>
				))}
			</svg>
		</div>
	);
}
