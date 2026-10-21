import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolFileChange, ToolOutputFileChange, ToolResult } from '../../src/agent-types';
import {
	checkAbort,
	isInside,
	MAX_FILE_BYTES,
	safeWorkspacePath,
	textResult,
	workspacePathRoot,
	type WorkspaceRoot,
} from './common';

interface Hunk {
	context?: string;
	oldLines: string[];
	newLines: string[];
	atEnd: boolean;
	addedLines: number;
	removedLines: number;
}
type Operation =
	| { kind: 'add'; path: string; text: string }
	| { kind: 'delete'; path: string }
	| { kind: 'update'; path: string; move?: string; hunks: Hunk[] };
interface Snapshot {
	bytes: Buffer;
	mode: number;
}

function parsePatch(patch: string): Operation[] {
	if (Buffer.byteLength(patch) > MAX_FILE_BYTES) throw new Error('Patch exceeds the 5 MiB limit.');
	const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n');
	if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch')
		throw new Error('Use *** Begin Patch and *** End Patch markers.');
	const operations: Operation[] = [];
	let index = 1;
	while (index < lines.length - 1) {
		const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[index++]);
		if (!header) throw new Error(`Invalid patch file header at line ${index}.`);
		const file = header[2];
		if (header[1] === 'Delete') {
			operations.push({ kind: 'delete', path: file });
			continue;
		}
		if (header[1] === 'Add') {
			const added: string[] = [];
			while (index < lines.length - 1 && !lines[index].startsWith('*** ')) {
				if (!lines[index].startsWith('+'))
					throw new Error(`Add-file content must start with + at line ${index + 1}.`);
				added.push(lines[index++].slice(1));
			}
			operations.push({
				kind: 'add',
				path: file,
				text: added.length ? `${added.join('\n')}\n` : '',
			});
			continue;
		}
		let move: string | undefined;
		if (lines[index]?.startsWith('*** Move to: '))
			move = lines[index++].slice('*** Move to: '.length);
		const hunks: Hunk[] = [];
		while (index < lines.length - 1 && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[index])) {
			if (lines[index] !== '@@' && !lines[index].startsWith('@@ '))
				throw new Error(`Expected @@ before an update hunk at line ${index + 1}.`);
			const hunk: Hunk = {
				context: lines[index++].slice(3) || undefined,
				oldLines: [],
				newLines: [],
				atEnd: false,
				addedLines: 0,
				removedLines: 0,
			};
			while (
				index < lines.length - 1 &&
				!lines[index].startsWith('@@') &&
				!lines[index].startsWith('*** ')
			) {
				const line = lines[index++];
				if (![' ', '-', '+'].includes(line[0]))
					throw new Error(
						`Invalid update line ${index}. Prefix context with a space, removals with -, and additions with +.`,
					);
				if (line[0] !== '+') hunk.oldLines.push(line.slice(1));
				if (line[0] !== '-') hunk.newLines.push(line.slice(1));
				if (line[0] === '+') hunk.addedLines++;
				if (line[0] === '-') hunk.removedLines++;
			}
			if (lines[index] === '*** End of File') {
				hunk.atEnd = true;
				index++;
			}
			if (!hunk.oldLines.length && !hunk.newLines.length)
				throw new Error('Empty update hunks are not allowed.');
			hunks.push(hunk);
		}
		if (!hunks.length) throw new Error(`No update hunks for ${file}.`);
		operations.push({ kind: 'update', path: file, move, hunks });
	}
	if (!operations.length || operations.length > 100)
		throw new Error('A patch must modify between 1 and 100 files.');
	return operations;
}

function updateText(original: string, hunks: Hunk[], file: string): string {
	const newline = original.includes('\r\n') ? '\r\n' : '\n';
	const lines = original.replace(/\r\n/g, '\n').split('\n');
	if (lines.at(-1) === '') lines.pop();
	let position = 0;
	for (const hunk of hunks) {
		if (hunk.context) {
			const found = lines.findIndex(
				(line, index) => index >= position && line.trimEnd() === hunk.context!.trimEnd(),
			);
			if (found < 0) throw new Error(`Could not find the @@ context in ${file}: ${hunk.context}`);
			position = found + 1;
		}
		let found = -1;
		if (!hunk.oldLines.length) found = hunk.atEnd ? lines.length : position;
		for (const trimWhitespace of [false, true]) {
			if (found >= 0) break;
			for (
				let candidate = position;
				candidate <= lines.length - hunk.oldLines.length;
				candidate++
			) {
				if (hunk.atEnd && candidate + hunk.oldLines.length !== lines.length) continue;
				if (
					hunk.oldLines.every((line, offset) =>
						trimWhitespace
							? lines[candidate + offset].trimEnd() === line.trimEnd()
							: lines[candidate + offset] === line,
					)
				) {
					found = candidate;
					break;
				}
			}
		}
		if (found < 0) throw new Error(`Patch context did not match ${file}; no files were changed.`);
		lines.splice(found, hunk.oldLines.length, ...hunk.newLines);
		position = found + hunk.newLines.length;
	}
	return lines.length ? `${lines.join(newline)}${newline}` : '';
}

async function snapshot(file: string): Promise<Snapshot | undefined> {
	try {
		const info = await lstat(file);
		if (!info.isFile()) throw new Error('Patch targets must be regular files.');
		if (info.size > MAX_FILE_BYTES) throw new Error('Patch target exceeds the 5 MiB limit.');
		return { bytes: await readFile(file), mode: info.mode };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

function lineCount(text: string): number {
	if (!text) return 0;
	let count = text.endsWith('\n') ? 0 : 1;
	for (const character of text) if (character === '\n') count++;
	return count;
}

function removedLineCount(bytes: Buffer): number | undefined {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return text.includes('\0') ? undefined : lineCount(text);
	} catch {
		return undefined;
	}
}

/** Validate the entire patch before writing, then roll back any failed commit. */
export async function applyWorkspacePatch(
	root: string | WorkspaceRoot[],
	input: string,
	signal: AbortSignal,
	allowOutside = false,
): Promise<ToolResult> {
	const roots = typeof root === 'string' ? [{ configured: root, path: root }] : root;
	if (!roots.length) throw new Error('Choose at least one workspace directory.');
	const primary = roots[0].path;
	const validateTarget = async (file: string) => {
		if ((await safeWorkspacePath(roots, file, false, allowOutside)) !== file)
			throw new Error(
				'A patch target path changed during execution. Retry with fresh file contents.',
			);
	};
	const displayPath = (file: string) =>
		isInside(primary, file) ? path.relative(primary, file) : file;
	const operations = parsePatch(input);
	const originals = new Map<string, Snapshot | undefined>();
	const updates = new Map<string, { bytes: Buffer; mode?: number } | undefined>();
	const touched = new Set<string>();
	const display: string[] = [];
	const fileChanges: ToolFileChange[] = [];
	const outputFiles: ToolOutputFileChange[] = [];
	for (const operation of operations) {
		checkAbort(signal);
		const file = await safeWorkspacePath(roots, operation.path, false, allowOutside);
		if (touched.has(file))
			throw new Error('Each patch path may appear only once. Combine hunks for the same file.');
		touched.add(file);
		const before = await snapshot(file);
		originals.set(file, before);
		if (operation.kind === 'add') {
			if (before) throw new Error(`Add File target already exists: ${operation.path}`);
			updates.set(file, { bytes: Buffer.from(operation.text) });
			display.push(`A ${displayPath(file)}`);
			fileChanges.push({
				kind: 'add',
				path: displayPath(file),
				addedLines: lineCount(operation.text),
				removedLines: 0,
			});
			outputFiles.push({ kind: 'add', path: file, size: Buffer.byteLength(operation.text) });
			continue;
		}
		if (!before) throw new Error(`Patch target does not exist: ${operation.path}`);
		if (operation.kind === 'delete') {
			updates.set(file, undefined);
			display.push(`D ${displayPath(file)}`);
			const removedLines = removedLineCount(before.bytes);
			fileChanges.push({
				kind: 'delete',
				path: displayPath(file),
				addedLines: 0,
				...(removedLines !== undefined ? { removedLines } : {}),
			});
			outputFiles.push({ kind: 'delete', path: file });
			continue;
		}
		const original = new TextDecoder('utf-8', { fatal: true }).decode(before.bytes);
		const text = updateText(original, operation.hunks, operation.path);
		const destination = operation.move
			? await safeWorkspacePath(roots, operation.move, false, allowOutside)
			: file;
		if (destination !== file) {
			if (touched.has(destination))
				throw new Error('Move destination overlaps another patch target.');
			touched.add(destination);
			const destinationBefore = await snapshot(destination);
			if (destinationBefore) throw new Error('Move destination already exists.');
			originals.set(destination, destinationBefore);
			updates.set(file, undefined);
		}
		updates.set(destination, { bytes: Buffer.from(text), mode: before.mode });
		display.push(`M ${displayPath(destination)}`);
		fileChanges.push({
			kind: destination !== file ? 'move' : 'update',
			path: displayPath(destination),
			...(destination !== file ? { previousPath: displayPath(file) } : {}),
			addedLines: operation.hunks.reduce((total, hunk) => total + hunk.addedLines, 0),
			removedLines: operation.hunks.reduce((total, hunk) => total + hunk.removedLines, 0),
		});
		outputFiles.push({
			kind: destination !== file ? 'move' : 'update',
			path: destination,
			...(destination !== file ? { previousPath: file } : {}),
			size: Buffer.byteLength(text),
		});
	}
	const createdDirectories: string[] = [];
	const committed: string[] = [];
	const staged = new Map<string, string>();
	try {
		for (const [file, next] of updates) {
			checkAbort(signal);
			await validateTarget(file);
			if (!next) continue;
			const missing: string[] = [];
			let parent = path.dirname(file);
			while (parent !== (allowOutside ? path.parse(file).root : workspacePathRoot(roots, file))) {
				try {
					await lstat(parent);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					missing.unshift(parent);
					parent = path.dirname(parent);
				}
			}
			for (const directory of missing) {
				await mkdir(directory);
				createdDirectories.push(directory);
			}
			const temp = path.join(path.dirname(file), `.freelm-patch-${randomUUID()}`);
			await writeFile(temp, next.bytes, { flag: 'wx', mode: next.mode ?? 0o644 });
			staged.set(file, temp);
		}
		for (const [file, next] of updates) {
			checkAbort(signal);
			await validateTarget(file);
			const current = await snapshot(file);
			const expected = originals.get(file);
			if (
				Boolean(current) !== Boolean(expected) ||
				(current && expected && !current.bytes.equals(expected.bytes))
			)
				throw new Error('A patch target changed during execution. Retry with fresh file contents.');
			if (next) await rename(staged.get(file)!, file);
			else await unlink(file);
			committed.push(file);
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const file of committed.reverse()) {
			try {
				await validateTarget(file);
				const original = originals.get(file);
				if (original) {
					await writeFile(file, original.bytes);
					await chmod(file, original.mode);
				} else await unlink(file);
			} catch {
				rollbackErrors.push(displayPath(file));
			}
		}
		if (rollbackErrors.length)
			throw new Error(
				`Patch failed and rollback needs attention for: ${rollbackErrors.join(', ')}. Original error: ${String(error)}`,
			);
		throw error;
	} finally {
		for (const temp of staged.values()) await unlink(temp).catch(() => {});
		for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => {});
	}
	return { ...textResult(`Applied patch:\n${display.join('\n')}`), fileChanges, outputFiles };
}
