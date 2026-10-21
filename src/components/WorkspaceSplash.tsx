import DrawingLogo from './DrawingLogo';
import './workspace-splash.css';

export default function WorkspaceSplash() {
	return (
		<div className="workspace-splash" role="status" aria-label="Loading workspace">
			<div className="workspace-splash-mark">
				<DrawingLogo />
			</div>
			<span className="workspace-splash-announcement">Loading workspace…</span>
		</div>
	);
}
