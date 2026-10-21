import type { ToolCallRecord, ToolFileChange } from '../agent-types';
import { editedFileChanges, type EditedFileChange, type PatchPreviewLine } from './edited-files';

export interface FileEditPreviewSection extends ToolFileChange {
	callId: string;
	diff: PatchPreviewLine[];
	omittedDiffLines: number;
}

export interface FileEditSummary extends ToolFileChange {
	editCount: number;
	previewSections: FileEditPreviewSection[];
	omittedPreviewSections: number;
}

const MAX_SECTIONS_PER_FILE = 8;
const MAX_SECTION_LINES = 200;
const MAX_SECTION_CHARS = 20_000;
const MAX_TOTAL_PREVIEW_LINES = 5_000;
const MAX_TOTAL_PREVIEW_CHARS = 500_000;

interface OrderedSection {
	order: number;
	section: FileEditPreviewSection;
}

interface Entry {
	firstSeen: number;
	file: ToolFileChange;
	editCount: number;
	sections: OrderedSection[];
	omittedSections: number;
}

/** Only normalize unambiguous POSIX separators/dot segments, never symlinks or case. */
function pathKey(path: string) {
	const parts = path.split('/').filter((part) => part && part !== '.');
	return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}` || path;
}

function addCounts(a: number | undefined, b: number | undefined) {
	if (a === undefined || b === undefined) return undefined;
	const sum = a + b;
	return Number.isSafeInteger(sum) ? sum : undefined;
}

function patchArgument(call: ToolCallRecord): unknown {
	try {
		const args: unknown = JSON.parse(call.arguments);
		return args && typeof args === 'object' && !Array.isArray(args)
			? (args as { patch?: unknown }).patch
			: undefined;
	} catch {
		return undefined;
	}
}

function successfulChanges(call: ToolCallRecord): EditedFileChange[] {
	if (call.status !== 'completed' || call.result?.isError) return [];
	if (call.name === 'apply_patch') return editedFileChanges(call, patchArgument(call));
	// Other tools may supply host-confirmed metadata. Their text/arguments are not patch evidence.
	if (!call.result?.fileChanges?.length) return [];
	return editedFileChanges({ ...call, result: { ...call.result, content: [] } }, undefined);
}

function previewSection(callId: string, file: EditedFileChange): FileEditPreviewSection {
	const diff: PatchPreviewLine[] = [];
	let chars = 0;
	let omittedDiffLines = file.omittedDiffLines;
	for (const line of file.diff) {
		if (diff.length >= MAX_SECTION_LINES || chars + line.text.length > MAX_SECTION_CHARS) {
			omittedDiffLines++;
			continue;
		}
		diff.push({ ...line });
		chars += line.text.length;
	}
	return {
		kind: file.kind,
		path: file.path,
		...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
		addedLines: file.addedLines,
		removedLines: file.removedLines,
		callId,
		diff,
		omittedDiffLines,
	};
}

class PreviewBudget {
	private queue: OrderedSection[] = [];
	private head = 0;
	private lines = 0;
	private chars = 0;

	discard({ section }: OrderedSection) {
		this.lines -= section.diff.length;
		this.chars -= section.diff.reduce((sum, line) => sum + line.text.length, 0);
		section.omittedDiffLines += section.diff.length;
		section.diff = [];
	}

	add(item: OrderedSection) {
		if (!item.section.diff.length) return;
		this.queue.push(item);
		this.lines += item.section.diff.length;
		this.chars += item.section.diff.reduce((sum, line) => sum + line.text.length, 0);
		while (this.lines > MAX_TOTAL_PREVIEW_LINES || this.chars > MAX_TOTAL_PREVIEW_CHARS) {
			this.discard(this.queue[this.head++]);
		}
		// Released per-file sections can remain ahead of the cursor; bound those references too.
		if (this.queue.length > MAX_TOTAL_PREVIEW_LINES * 2) {
			this.queue = this.queue.slice(this.head).filter((entry) => entry.section.diff.length);
			this.head = 0;
		}
	}
}

function retainRecentSections(entry: Entry, budget: PreviewBudget) {
	entry.sections.sort((a, b) => a.order - b.order);
	if (entry.sections.length > MAX_SECTIONS_PER_FILE) {
		const omitted = entry.sections.length - MAX_SECTIONS_PER_FILE;
		for (const section of entry.sections.splice(0, omitted)) budget.discard(section);
		entry.omittedSections += omitted;
	}
}

/**
 * Aggregate one response's successful file-edit evidence, not the current filesystem diff.
 * Counts include every edit. Missing/binary/legacy counts remain unknown. Moves update the
 * current path without keeping aliases, so recreating the old path remains a separate file.
 */
export function aggregateFileEdits(calls: readonly ToolCallRecord[]): FileEditSummary[] {
	const byPath = new Map<string, Entry>();
	const entries = new Set<Entry>();
	const budget = new PreviewBudget();
	let order = 0;
	for (const call of calls) {
		for (const change of successfulChanges(call)) {
			const key = pathKey(change.path);
			const oldKey =
				change.kind === 'move' && change.previousPath ? pathKey(change.previousPath) : key;
			let entry = byPath.get(oldKey);
			const destination = byPath.get(key);
			if (entry && destination && entry !== destination) {
				entry.firstSeen = Math.min(entry.firstSeen, destination.firstSeen);
				entry.file.addedLines = addCounts(entry.file.addedLines, destination.file.addedLines);
				entry.file.removedLines = addCounts(entry.file.removedLines, destination.file.removedLines);
				entry.editCount += destination.editCount;
				entry.omittedSections += destination.omittedSections;
				entry.sections.push(...destination.sections);
				entries.delete(destination);
			} else if (!entry) entry = destination;
			if (!entry) {
				entry = {
					firstSeen: order,
					file: { kind: change.kind, path: change.path, addedLines: 0, removedLines: 0 },
					editCount: 0,
					sections: [],
					omittedSections: 0,
				};
				entries.add(entry);
			}
			if (oldKey !== key) byPath.delete(oldKey);
			if (change.kind === 'move') {
				entry.file.previousPath ??= change.previousPath;
				entry.file.kind = 'move';
			} else if (change.kind === 'add' || change.kind === 'delete') {
				entry.file.kind = change.kind;
			} else if (entry.file.kind === 'delete') entry.file.kind = 'update';
			entry.file.path = change.path;
			entry.file.addedLines = addCounts(entry.file.addedLines, change.addedLines);
			entry.file.removedLines = addCounts(entry.file.removedLines, change.removedLines);
			entry.editCount++;
			const section = { order: order++, section: previewSection(call.id, change) };
			entry.sections.push(section);
			budget.add(section);
			retainRecentSections(entry, budget);
			byPath.set(key, entry);
		}
	}
	return [...entries]
		.sort((a, b) => a.firstSeen - b.firstSeen)
		.map((entry) => ({
			...entry.file,
			editCount: entry.editCount,
			previewSections: entry.sections.map(({ section }) => section),
			omittedPreviewSections: entry.omittedSections,
		}));
}
