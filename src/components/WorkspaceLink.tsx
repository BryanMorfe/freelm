import type { ComponentProps, MouseEvent } from 'react';
import { codeBrowserLink, codeFileLink, useCodeSurfaceActions } from './code-surface-context';

/** Links in Code share the same file/browser destination across replies and sources. */
export default function WorkspaceLink({ onClick, onAuxClick, ...props }: ComponentProps<'a'>) {
	const surface = useCodeSurfaceActions();
	const file = surface && codeFileLink(props.href || '');
	const url = surface && codeBrowserLink(props.href || '');
	const open = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.defaultPrevented || !surface || props.download !== undefined) return;
		if (!file && !url) return;
		event.preventDefault();
		if (file) surface.openFile(file.path, file.line);
		else if (url) surface.openBrowser(url);
	};
	return (
		<a
			{...props}
			onClick={(event) => {
				onClick?.(event);
				open(event);
			}}
			onAuxClick={(event) => {
				onAuxClick?.(event);
				if (event.button === 1) open(event);
			}}
		/>
	);
}
