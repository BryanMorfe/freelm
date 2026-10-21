import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolResult, ToolSettings } from '../../src/agent-types';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const textResult = (value: unknown, isError = false): ToolResult => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
	...(isError ? { isError: true } : {}),
});

export function requiredString(
	args: Record<string, unknown>,
	name: string,
	max = 1_000_000,
): string {
	const value = args[name];
	if (typeof value !== 'string' || !value || value.length > max) {
		throw new Error(`${name} must be a nonempty string of at most ${max} characters.`);
	}
	return value;
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.floor(value)))
		: fallback;
}

export function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new Error('Tool execution was cancelled.');
}

export function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
	);
}

export async function workspaceRoot(configured: string): Promise<string> {
	if (!configured || !path.isAbsolute(configured))
		throw new Error('Choose an absolute workspace folder in Tools settings first.');
	const root = await realpath(configured);
	if (!(await stat(root)).isDirectory())
		throw new Error('The configured workspace is not a directory.');
	return root;
}

export interface WorkspaceRoot {
	configured: string;
	path: string;
}

/** Resolve chosen root aliases (such as /tmp on macOS), not symlinks below those roots. */
export async function workspaceRoots(
	settings: Pick<ToolSettings, 'workspaceRoot' | 'workspaceRoots' | 'workspacePathsUnrestricted'>,
): Promise<WorkspaceRoot[]> {
	const configured = settings.workspaceRoots?.length
		? settings.workspaceRoots
		: settings.workspacePathsUnrestricted && settings.workspaceRoot
			? [settings.workspaceRoot]
			: (settings.workspaceRoots ?? (settings.workspaceRoot ? [settings.workspaceRoot] : []));
	if (!configured.length || configured.length > 32)
		throw new Error(
			'Choose directories for this project or a workspace folder for a chat outside a project.',
		);
	return await Promise.all(
		configured.map(async (directory) => ({
			configured: path.resolve(directory),
			path: await workspaceRoot(directory),
		})),
	);
}

export function workspacePathRoot(roots: WorkspaceRoot[], candidate: string): string {
	const root = [...roots]
		.sort((a, b) => b.path.length - a.path.length)
		.find((root) => isInside(root.path, candidate));
	if (!root) throw new Error('Path escapes the configured workspace directories.');
	return root.path;
}

/** Relative paths use the first directory; absolute paths can use any explicitly bound root. */
export async function safeWorkspacePath(
	roots: WorkspaceRoot[],
	input: string,
	allowRoot = false,
	allowOutside = false,
): Promise<string> {
	if (!roots.length || !input || input.includes('\0'))
		throw new Error('A valid workspace-relative path is required.');
	let resolved = path.resolve(roots[0].path, input);
	if (path.isAbsolute(input)) {
		const alias = [...roots]
			.sort((a, b) => b.configured.length - a.configured.length)
			.find((root) => isInside(root.configured, resolved));
		if (alias) resolved = path.resolve(alias.path, path.relative(alias.configured, resolved));
	}
	if (allowOutside) {
		// Consent belongs to AgentHost. Resolve aliases once so patch preflight and
		// commit operate on the same canonical targets, including missing files.
		let existing = resolved;
		const missing: string[] = [];
		while (true) {
			try {
				const canonical = await realpath(existing);
				if (missing.length && !(await stat(canonical)).isDirectory())
					throw new Error('A parent path is not a directory.');
				resolved = path.resolve(canonical, ...missing);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				const parent = path.dirname(existing);
				if (parent === existing) throw error;
				missing.unshift(path.basename(existing));
				existing = parent;
			}
		}
		return await safePath(path.parse(resolved).root, resolved, allowRoot);
	}
	return await safePath(workspacePathRoot(roots, resolved), resolved, allowRoot);
}

/** Reject symlinks below the explicitly chosen root, including missing targets. */
export async function safePath(root: string, input: string, allowRoot = false): Promise<string> {
	if (!input || input.includes('\0'))
		throw new Error('A valid workspace-relative path is required.');
	const resolved = path.resolve(root, input);
	if (!isInside(root, resolved) || (!allowRoot && resolved === root))
		throw new Error('Path escapes the configured workspace.');
	const components = path.relative(root, resolved).split(path.sep).filter(Boolean);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = path.join(current, component);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink())
				throw new Error('Symbolic links are not allowed in tool file paths.');
			if (index < components.length - 1 && !info.isDirectory())
				throw new Error('A parent path is not a directory.');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			break;
		}
	}
	return resolved;
}

export function objectSchema(
	properties: Record<string, unknown>,
	required: string[] = [],
): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

export const stringParam = (description: string) => ({ type: 'string', description });
