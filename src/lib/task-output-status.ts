import type { TaskOutputFileStatus, TaskOutputStatusResult } from '../task-output-types';
import type { TaskOutput, TaskOutputsData } from './task-outputs';

const MAX_NOTICES = 16;
const safeString = (value: unknown, max: number): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= max &&
	!/[\u0000-\u001f\u007f]/.test(value);

/**
 * Tool history proves creation; host metadata proves that a local output still exists.
 * Pending, missing, unsafe, or unknown files stay hidden. Embedded artifacts remain
 * available independently of the original host filesystem.
 */
export function visibleTaskOutputs(
	data: TaskOutputsData,
	status?: TaskOutputStatusResult,
): TaskOutputsData {
	const localIds = new Set(
		data.items.filter((output) => output.kind === 'local-file').map((output) => output.id),
	);
	const checks = new Map<string, TaskOutputFileStatus>();
	const ambiguous = new Set<string>();
	for (const value of Array.isArray(status?.files) ? status.files : []) {
		if (
			!value ||
			!safeString(value.id, 8192) ||
			!localIds.has(value.id) ||
			typeof value.exists !== 'boolean'
		)
			continue;
		// Multiple statuses for one ID are an invalid reply, not independent evidence.
		if (checks.has(value.id)) ambiguous.add(value.id);
		else checks.set(value.id, value);
	}
	const seenIdentities = new Set<string>();
	const seenPaths = new Set<string>();
	const items = data.items.filter((output) => {
		if (output.kind !== 'local-file') return true;
		const check = checks.get(output.id);
		if (!check?.exists || ambiguous.has(output.id)) return false;
		const canonicalPath =
			safeString(check.canonicalPath, 4096) && check.canonicalPath.startsWith('/')
				? check.canonicalPath
				: output.path;
		const identity = safeString(check.identity, 8192) ? check.identity : undefined;
		if (
			(identity && seenIdentities.has(identity)) ||
			(canonicalPath && seenPaths.has(canonicalPath))
		)
			return false;
		if (identity) seenIdentities.add(identity);
		if (canonicalPath) seenPaths.add(canonicalPath);
		return true;
	});
	const notices = [...data.notices];
	for (const notice of Array.isArray(status?.notices) ? status.notices : []) {
		if (typeof notice !== 'string' || !notice.trim()) continue;
		const text = notice.trim().slice(0, 300);
		if (!notices.includes(text) && notices.length < MAX_NOTICES) notices.push(text);
	}
	return {
		items,
		hasOutputs: items.length > 0,
		truncated: data.truncated || status?.truncated === true,
		notices,
	};
}

/** Use a project-relative display label while retaining the actual path on the output. */
export function outputDisplayPath(output: TaskOutput, workspaceRoot?: string): string | undefined {
	const filename = output.path;
	if (!filename) return;
	if (!safeString(workspaceRoot, 4096) || !workspaceRoot.startsWith('/')) return filename;
	const root = workspaceRoot.replace(/\/+$/, '');
	if (filename.startsWith(`${root}/`)) return filename.slice(root.length + 1);
	return filename;
}
