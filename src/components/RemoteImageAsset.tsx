import { userFacingError } from '../lib/user-facing-error';
import { useEffect, useRef, useState } from 'react';
import { Download, ImageOff, LoaderCircle, RotateCcw } from 'lucide-react';
import type { MediaAsset } from '../types';

export function requiresHostImage(workspaceId: string, url: string): boolean {
	return workspaceId !== 'local' && /^\s*https?:/i.test(url);
}

/** Resolved image data lives only for this selected preview, never in the saved workspace. */
export default function RemoteImageAsset({
	asset,
	workspaceId,
	connectionId,
}: {
	asset: MediaAsset;
	workspaceId: string;
	connectionId: string;
}) {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [attempt, setAttempt] = useState(0);
	const pending = useRef<{ key: string; result: Promise<string> } | null>(null);

	useEffect(() => {
		let current = true;
		setUrl(null);
		setError('');
		async function resolve() {
			if (!window.desktop) throw new Error('Open the desktop app to load images from this host.');
			const result = await window.desktop.instanceAsset(workspaceId, connectionId, asset.url);
			if (result.status < 200 || result.status >= 300)
				throw new Error(`The host could not load this image (HTTP ${result.status}).`);
			const mimeType = result.contentType.split(';')[0].trim().toLowerCase();
			if (result.encoding !== 'base64' || !/^image\/[a-z0-9.+-]+$/.test(mimeType) || !result.body)
				throw new Error('The host returned an unsupported or empty image.');
			return `data:${mimeType};base64,${result.body}`;
		}
		const key = JSON.stringify([workspaceId, connectionId, asset.url, attempt]);
		if (pending.current?.key !== key) pending.current = { key, result: resolve() };
		void pending.current.result
			.then((resolved) => {
				if (current) setUrl(resolved);
			})
			.catch((cause: unknown) => {
				if (current)
					setError(
						cause instanceof Error ? cause.message : 'Could not load this image from the host.',
					);
			});
		return () => {
			current = false;
		};
	}, [workspaceId, connectionId, asset.url, attempt]);

	return (
		<div className="media-asset">
			{url && !error ? (
				<>
					<img
						src={url}
						alt={asset.name || 'Generated image'}
						className="media-generated-image"
						onError={() => {
							setUrl(null);
							setError('The image returned by the host could not be displayed.');
						}}
					/>
					<a
						className="media-download"
						href={url}
						download={asset.name}
						aria-label={`Download ${asset.name}`}
						title="Download"
					>
						<Download size={16} />
					</a>
				</>
			) : (
				<div className="media-remote-image-status" role={error ? 'alert' : 'status'}>
					{error ? <ImageOff size={25} /> : <LoaderCircle size={25} className="media-spin" />}
					<p>{error ? userFacingError(error) : 'Loading image from the host…'}</p>
					{error && (
						<button
							className="secondary-button compact"
							onClick={() => setAttempt((value) => value + 1)}
						>
							<RotateCcw size={14} /> Retry image
						</button>
					)}
				</div>
			)}
		</div>
	);
}
