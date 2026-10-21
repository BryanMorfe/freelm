import { memo } from 'react';
import { BookOpen } from 'lucide-react';
import type { ResearchSource } from '../research-types';
import './research-results.css';
import WorkspaceLink from './WorkspaceLink';

/** Source links remain available when intermediate search activity is collapsed. */
export default memo(function ResearchResults({
	results,
}: {
	results: { sources: ResearchSource[] };
}) {
	if (!results.sources.length) return null;
	return (
		<div className="research-results" aria-label="Research results">
			{!!results.sources.length && (
				<details className="research-sources">
					<summary>
						<BookOpen size={14} aria-hidden="true" />
						<span>Sources · {results.sources.length}</span>
					</summary>
					<ul className="research-source-list" aria-label="Sources">
						{results.sources.map((source) => (
							<li key={source.id} className="research-source-row">
								<span className="research-source-title" title={source.title}>
									{source.title}
								</span>
								<WorkspaceLink
									href={source.url}
									title={source.url}
									target="_blank"
									rel="noreferrer"
									className="research-source-url"
								>
									{source.url}
								</WorkspaceLink>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
});
