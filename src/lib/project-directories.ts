/** Normalize an absolute macOS/Linux path without accessing the filesystem. */
export function normalizeProjectDirectory(directory: string): string {
	const segments: string[] = [];
	for (const segment of directory.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}

/** Shared with the renderer: project directory validation must remain browser-safe. */
export function validProjectDirectories(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 32 &&
		value.every(
			(directory) =>
				typeof directory === 'string' &&
				directory.length > 0 &&
				directory.length <= 4096 &&
				!directory.includes('\0') &&
				directory.startsWith('/'),
		) &&
		new Set(value.map(normalizeProjectDirectory)).size === value.length
	);
}

/** A predictable, single directory name; never interpret a project title as a path. */
export function suggestedProjectDirectoryName(name: string): string {
	const cleaned = name
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]+/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[. ]+|[. ]+$/g, '');
	const encoder = new TextEncoder();
	let result = '';
	let bytes = 0;
	for (const character of cleaned) {
		// Use the same replacement for malformed UTF-16 as Node's filesystem encoding.
		const point =
			character.length === 1 && /[\ud800-\udfff]/.test(character) ? '\ufffd' : character;
		const length = encoder.encode(point).length;
		if (bytes + length > 120) break;
		result += point;
		bytes += length;
	}
	return result.replace(/[. ]+$/g, '') || 'Untitled project';
}
