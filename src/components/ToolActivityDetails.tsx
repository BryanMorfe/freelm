import type { ReactNode } from 'react';
import type { ToolCallRecord, ToolContent } from '../agent-types';
import { userFacingError } from '../lib/user-facing-error';
import CodeBlock from './CodeBlock';
import WorkspaceLink from './WorkspaceLink';
import './tool-activity-details.css';

type RequestDetail = { title: string; text: string };
type ImageContent = Extract<ToolContent, { type: 'image' }>;

function string(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value : '';
}
function httpUrl(value: unknown): string | undefined {
	try {
		const url = new URL(string(value));
		if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
	} catch {
		// A session reference or invalid URL is still readable text, never a link.
	}
}

function webRequestDetails(args: Record<string, unknown>): RequestDetail[] {
	const rows: RequestDetail[] = [];
	for (const [field, title] of [
		['search_query', 'Query'],
		['image_query', 'Image query'],
		['open', 'Page'],
		['find', 'Find'],
		['click', 'Link'],
		['screenshot', 'PDF page'],
	] as const) {
		const entries = args[field];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const ref = string(entry.ref_id);
			let text = field === 'search_query' || field === 'image_query' ? string(entry.q) : ref;
			if (field === 'find') text = [string(entry.pattern), ref].filter(Boolean).join(' · ');
			if (field === 'click' && Number.isInteger(entry.id))
				text = [ref, `link ${entry.id}`].filter(Boolean).join(' · ');
			if (field === 'screenshot' && Number.isInteger(entry.pageno))
				text = [ref, `page ${entry.pageno + 1}`].filter(Boolean).join(' · ');
			if (text) rows.push({ title, text });
		}
	}
	return rows;
}

function RequestRows({ rows }: { rows: RequestDetail[] }) {
	return (
		<dl className="tool-request-details">
			{rows.map((row, index) => (
				<div key={index}>
					<dt>{row.title}</dt>
					<dd>{row.text}</dd>
				</div>
			))}
		</dl>
	);
}

function ImageDetails({ images }: { images: ImageContent[] }) {
	return (
		<div className="tool-inspected-images">
			{images.map((image, index) => (
				<img key={index} src={image.dataUrl} alt={image.name || `Viewed image ${index + 1}`} />
			))}
		</div>
	);
}

/** A process result is command output, not an exception to rewrite. */
export function toolErrorMessage(call: ToolCallRecord): string | undefined {
	if ((call.status !== 'failed' && !call.result?.isError) || call.result?.process || !call.result)
		return;
	const text = call.result.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
	return userFacingError(text, 'The tool could not complete. Try again.');
}

/** Readable, lazy content behind activity labels; protocol JSON stays in Debug. */
export function toolActivityDetails(
	call: ToolCallRecord,
	args: Record<string, unknown>,
): { kind?: string; content: ReactNode } | undefined {
	const details = requestDetails(call, args);
	const error = toolErrorMessage(call);
	if (!error) return details;
	return {
		kind: details?.kind,
		content: (
			<>
				<p className="tool-error-message">{error}</p>
				{details?.content}
			</>
		),
	};
}

function requestDetails(
	call: ToolCallRecord,
	args: Record<string, unknown>,
): { kind: string; content: ReactNode } | undefined {
	if (call.name.startsWith('computer_')) {
		const action =
			args.action && typeof args.action === 'object'
				? (args.action as Record<string, unknown>)
				: undefined;
		const rows: RequestDetail[] = [
			{
				title: 'App',
				text: call.result?.computer?.app.name || string(args.appId) || 'Approved application',
			},
		];
		if (action) {
			if (string(action.type))
				rows.push({ title: 'Action', text: string(action.type).replaceAll('_', ' ') });
			if (typeof action.text === 'string') rows.push({ title: 'Text', text: action.text });
			if (string(action.key))
				rows.push({
					title: 'Key',
					text: [...(Array.isArray(action.modifiers) ? action.modifiers : []), action.key].join(
						' + ',
					),
				});
		}
		return { kind: 'computer activity', content: <RequestRows rows={rows} /> };
	}
	if (call.name === 'update_plan') {
		const plan = args.plan;
		if (
			!Array.isArray(plan) ||
			!plan.length ||
			!plan.every((step) => step && string(step.step) && string(step.status))
		)
			return;
		return {
			kind: 'plan',
			content: (
				<>
					{string(args.explanation) && (
						<p className="tool-plan-explanation">{string(args.explanation)}</p>
					)}
					<ol className="tool-plan">
						{plan.map((step, index) => (
							<li key={index} data-status={step.status}>
								{step.step}
							</li>
						))}
					</ol>
				</>
			),
		};
	}
	if (call.name === 'python.exec' && string(args.code))
		return {
			kind: 'Python code',
			content: <CodeBlock text={string(args.code)} language="python" />,
		};
	if (call.name === 'web.run') {
		const rows = webRequestDetails(args);
		const sources = call.result?.research?.sources?.filter((source) => httpUrl(source.url)) || [];
		// Search results contain links/metadata only. Never load their remote image URLs.
		const images = Array.isArray(args.screenshot)
			? call.result?.content.filter((item): item is ImageContent => item.type === 'image') || []
			: [];
		if (!rows.length && !sources.length && !images.length) return;
		return {
			kind: 'web activity',
			content: (
				<>
					{!!rows.length && <RequestRows rows={rows} />}
					{!!sources.length && (
						<div className="tool-source-details">
							{sources.map((source) => (
								<div key={source.id}>
									<span>{source.title}</span>
									<WorkspaceLink href={httpUrl(source.url)} target="_blank" rel="noreferrer">
										{source.url}
									</WorkspaceLink>
								</div>
							))}
						</div>
					)}
					{!!images.length && <ImageDetails images={images} />}
				</>
			),
		};
	}
	if (call.name === 'view_image' || call.name === 'image.view') {
		const target = string(call.name === 'view_image' ? args.path : args.target);
		const images =
			call.result?.content.filter((item): item is ImageContent => item.type === 'image') || [];
		if (!target && !images.length) return;
		return {
			kind: 'image activity',
			content: (
				<>
					{target && <RequestRows rows={[{ title: 'Image', text: target }]} />}
					{!!images.length && <ImageDetails images={images} />}
				</>
			),
		};
	}
}
