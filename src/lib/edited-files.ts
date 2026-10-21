import type { ToolCallRecord, ToolFileChange } from '../agent-types';

export interface PatchPreviewLine {
	kind: 'added' | 'removed' | 'context' | 'hunk';
	text: string;
}
export interface EditedFileChange extends ToolFileChange {
	diff: PatchPreviewLine[];
	omittedDiffLines: number;
}

const MAX_PATCH_CHARS = 5 * 1024 * 1024;
const MAX_PREVIEW_LINES = 500;
const MAX_PREVIEW_CHARS = 100_000;

function* patchLines(patch: string) {
	let offset = 0;
	while (offset < patch.length) {
		let end = patch.indexOf('\n', offset);
		if (end === -1) end = patch.length;
		const line = patch.slice(offset, end);
		yield line.endsWith('\r') ? line.slice(0, -1) : line;
		offset = end + 1;
	}
}

/** Parse the actual apply_patch protocol, retaining bounded previews rather than a giant DOM. */
export function parseEditedFiles(patch: unknown): EditedFileChange[] {
	if (typeof patch !== 'string' || patch.length > MAX_PATCH_CHARS) return [];
	const files: EditedFileChange[] = [];
	let current: EditedFileChange | undefined;
	let began = false,
		ended = false,
		hunk = false,
		hunkLines = 0,
		previewChars = 0;
	const pushLine = (line: string, kind: PatchPreviewLine['kind']) => {
		if (!current) return;
		if (
			current.diff.length >= MAX_PREVIEW_LINES ||
			previewChars + line.length > MAX_PREVIEW_CHARS
		) {
			current.omittedDiffLines++;
			return;
		}
		current.diff.push({ kind, text: line });
		previewChars += line.length;
	};
	for (const line of patchLines(patch)) {
		if (!began) {
			if (line !== '*** Begin Patch') return [];
			began = true;
			continue;
		}
		if (ended) {
			if (line.trim()) return [];
			continue;
		}
		if (line === '*** End Patch') {
			if (current && ['update', 'move'].includes(current.kind) && (!hunk || !hunkLines)) return [];
			ended = true;
			continue;
		}
		const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
		if (header) {
			if (current && ['update', 'move'].includes(current.kind) && (!hunk || !hunkLines)) return [];
			const kind = header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update';
			current = {
				kind,
				path: header[2],
				addedLines: 0,
				...(kind !== 'delete' ? { removedLines: 0 } : {}),
				diff: [],
				omittedDiffLines: 0,
			};
			files.push(current);
			if (files.length > 100) return [];
			hunk = false;
			hunkLines = 0;
			previewChars = 0;
			continue;
		}
		if (!current) return [];
		const move = /^\*\*\* Move to: (.+)$/.exec(line);
		if (move && current.kind === 'update' && !hunk) {
			current.previousPath = current.path;
			current.path = move[1];
			current.kind = 'move';
			continue;
		}
		if (['update', 'move'].includes(current.kind)) {
			if (line === '@@' || line.startsWith('@@ ')) {
				if (hunk && !hunkLines) return [];
				hunk = true;
				hunkLines = 0;
				pushLine(line, 'hunk');
				continue;
			}
			if (line === '*** End of File' && hunk) continue;
			if (!hunk) return [];
		} else if (current.kind === 'delete') return [];
		if (line.startsWith('+')) {
			current.addedLines!++;
			pushLine(line, 'added');
		} else if (line.startsWith('-') && current.kind !== 'add') {
			current.removedLines!++;
			pushLine(line, 'removed');
		} else if (line.startsWith(' ') && current.kind !== 'add') pushLine(line, 'context');
		else return [];
		hunkLines++;
	}
	return ended ? files : [];
}

function safeCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validChanges(value: unknown): value is ToolFileChange[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 100 &&
		value.every(
			(file) =>
				file &&
				typeof file === 'object' &&
				['add', 'update', 'delete', 'move'].includes(file.kind) &&
				typeof file.path === 'string' &&
				!!file.path &&
				file.path.length <= 4096 &&
				(file.previousPath === undefined || typeof file.previousPath === 'string') &&
				(file.addedLines === undefined || safeCount(file.addedLines)) &&
				(file.removedLines === undefined || safeCount(file.removedLines)),
		)
	);
}

/** Host-confirmed metadata supplies actual deletions; old records fall back to their patch. */
export function editedFileChanges(call: ToolCallRecord, patch: unknown): EditedFileChange[] {
	const authored = parseEditedFiles(patch);
	if (call.status !== 'completed' || call.result?.isError) return authored;
	if (validChanges(call.result?.fileChanges)) {
		return call.result.fileChanges.map((file, index) => {
			const preview =
				authored.find((item) => item.path === file.path) ??
				(authored.length === call.result!.fileChanges!.length ? authored[index] : undefined);
			return {
				...file,
				diff: preview?.diff ?? [],
				omittedDiffLines: preview?.omittedDiffLines ?? 0,
			};
		});
	}
	if (authored.length) return authored;
	// Legacy successful host results name applied paths even when original arguments are absent.
	const paths: EditedFileChange[] = [];
	for (const part of call.result?.content ?? []) {
		if (part.type !== 'text' || !part.text.startsWith('Applied patch:\n')) continue;
		for (const line of part.text.slice('Applied patch:\n'.length).split(/\r?\n/)) {
			const match = /^([AMD]) (.+)$/.exec(line);
			if (match && paths.length < 100)
				paths.push({
					kind: match[1] === 'A' ? 'add' : match[1] === 'D' ? 'delete' : 'update',
					path: match[2],
					diff: [],
					omittedDiffLines: 0,
				});
		}
	}
	return paths;
}

export function editedFileTotals(files: readonly ToolFileChange[]) {
	const total = (dimension: 'addedLines' | 'removedLines') => {
		let sum = 0;
		for (const file of files) {
			const value = file[dimension];
			if (!safeCount(value) || !Number.isSafeInteger(sum + value)) return undefined;
			sum += value;
		}
		return sum;
	};
	const added = total('addedLines');
	const removed = total('removedLines');
	return { added, removed };
}
