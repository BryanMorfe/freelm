import { watch, type FSWatcher } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolOutputFileChange } from '../../src/agent-types';

const EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'node_modules',
	'.venv',
	'venv',
	'__pycache__',
	'.cache',
	'.next',
	'.nuxt',
	'.turbo',
	'.pytest_cache',
	'.mypy_cache',
	'.ruff_cache',
	'.tox',
]);
const MAX_OUTPUT_EVENTS = 1000;

interface FileState {
	size: number;
	modifiedAt: number;
	identity: string;
}
interface Inventory {
	files: Map<string, FileState>;
	directories: Set<string>;
	complete: boolean;
}
export interface OutputTracking {
	outputFiles: ToolOutputFileChange[];
	outputTrackingNotices?: string[];
}
interface TrackerOptions {
	maxEntries?: number;
	maxScanMs?: number;
	maxWatchers?: number;
	minimumScanIntervalMs?: number;
}
interface ScanBudget {
	deadline: number;
	remaining: number;
}

/** File observations are bounded metadata scans, never content reads or a shell parser.
 * Changes are observed while a command runs, not a guarantee that its process created
 * them: simultaneous user edits or another task in the same directory may be observed.
 * Nonrecursive directory watchers only mark inventories dirty. Node's recursive watcher
 * can synchronously walk directories on Linux, so it is deliberately not used here.
 */
export class OutputFileTracker {
	private inventories = new Map<string, Inventory>();
	private watchers = new Map<string, FSWatcher>();
	private notices = new Set<string>();
	private dirty = 0;
	private scannedVersion = -1;
	private lastScanAt = 0;
	private pollingFallback = false;
	private closed = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly limits: Required<TrackerOptions>;

	private constructor(
		private roots: string[],
		options: TrackerOptions,
	) {
		this.limits = {
			maxEntries: options.maxEntries ?? 20_000,
			maxScanMs: options.maxScanMs ?? 1500,
			maxWatchers: options.maxWatchers ?? 1500,
			minimumScanIntervalMs: options.minimumScanIntervalMs ?? 250,
		};
	}

	static async create(roots: string[], options: TrackerOptions = {}): Promise<OutputFileTracker> {
		const unique = [...new Set(roots.map((root) => path.resolve(root)))];
		// Parent roots already cover nested workdirs; avoid duplicate observations.
		const selected = unique.filter(
			(root) =>
				!unique.some((other) => {
					const relative = path.relative(other, root);
					return (
						other !== root &&
						relative !== '..' &&
						!relative.startsWith(`..${path.sep}`) &&
						!path.isAbsolute(relative) &&
						!relative.split(path.sep).some((name) => EXCLUDED_DIRECTORIES.has(name))
					);
				}),
		);
		const tracker = new OutputFileTracker(selected, options);
		if (!selected.length)
			tracker.notices.add(
				'Automatic output discovery needs an assigned project directory or an explicit command workdir. The default home directory is not scanned.',
			);
		const budget = tracker.scanBudget();
		for (const root of selected) tracker.inventories.set(root, await tracker.scan(root, budget));
		await tracker.synchronizeWatchers();
		tracker.scannedVersion = tracker.dirty;
		tracker.lastScanAt = Date.now();
		return tracker;
	}

	collect(force = false): Promise<OutputTracking> {
		const operation = this.queue.then(() => this.collectNow(force));
		this.queue = operation.catch(() => {});
		return operation;
	}

	private async collectNow(force: boolean): Promise<OutputTracking> {
		const events: ToolOutputFileChange[] = [];
		if (this.closed) return { outputFiles: [] };
		const elapsed = Date.now() - this.lastScanAt;
		if (
			!force &&
			(elapsed < this.limits.minimumScanIntervalMs ||
				(this.dirty === this.scannedVersion && (!this.pollingFallback || elapsed < 2000)))
		)
			return this.result(events);
		const version = this.dirty;
		const budget = this.scanBudget();
		for (const root of this.roots) {
			const before = this.inventories.get(root)!;
			const after = await this.scan(root, budget);
			// An incomplete baseline cannot prove creation, and an incomplete later scan
			// cannot prove deletion. Keep the last complete baseline until coverage returns.
			if (before.complete && after.complete) events.push(...this.diff(before, after));
			else if (!before.complete && after.complete)
				this.notices.add(
					`Output discovery resumed for ${root}; files already present when coverage resumed are not attributed to this command.`,
				);
			if (after.complete || !before.complete) this.inventories.set(root, after);
		}
		await this.synchronizeWatchers();
		this.scannedVersion = version;
		this.lastScanAt = Date.now();
		if (events.length > MAX_OUTPUT_EVENTS) {
			this.notices.add(
				`More than ${MAX_OUTPUT_EVENTS} file changes were observed in one command result; only the first ${MAX_OUTPUT_EVENTS} are listed.`,
			);
			events.length = MAX_OUTPUT_EVENTS;
		}
		return this.result(events);
	}

	private result(outputFiles: ToolOutputFileChange[]): OutputTracking {
		return {
			outputFiles,
			...(this.notices.size ? { outputTrackingNotices: [...this.notices].slice(0, 100) } : {}),
		};
	}

	private scanBudget(): ScanBudget {
		return { deadline: Date.now() + this.limits.maxScanMs, remaining: this.limits.maxEntries };
	}

	private async scan(root: string, budget: ScanBudget): Promise<Inventory> {
		const inventory: Inventory = { files: new Map(), directories: new Set(), complete: true };
		const pending = [root];
		let nextDirectory = 0;
		try {
			const info = await lstat(root);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a real directory');
			while (nextDirectory < pending.length) {
				if (budget.remaining <= 0 || Date.now() >= budget.deadline) {
					inventory.complete = false;
					this.notices.add(
						`Automatic output discovery reached its metadata scan limit for ${root}; some files may be unavailable in Outputs.`,
					);
					break;
				}
				const directory = pending[nextDirectory++];
				// Recheck every descendant immediately before opening it; symlinks are never traversed.
				const directoryInfo = await lstat(directory);
				if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
				const handle = await opendir(directory);
				inventory.directories.add(directory);
				for await (const entry of handle) {
					budget.remaining--;
					if (budget.remaining < 0 || Date.now() >= budget.deadline) {
						inventory.complete = false;
						this.notices.add(
							`Automatic output discovery reached its metadata scan limit for ${root}; some files may be unavailable in Outputs.`,
						);
						break;
					}
					const filename = path.join(directory, entry.name);
					if (entry.isSymbolicLink()) {
						this.notices.add('Symbolic links are excluded from automatic output discovery.');
						continue;
					}
					if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
						this.notices.add(
							'Dependency and cache directories are excluded from automatic output discovery.',
						);
						continue;
					}
					const info = await lstat(filename);
					if (info.isSymbolicLink()) continue;
					if (info.isDirectory()) pending.push(filename);
					else if (info.isFile())
						inventory.files.set(filename, {
							size: info.size,
							modifiedAt: info.mtimeMs,
							identity: `${info.dev}:${info.ino}`,
						});
				}
				if (!inventory.complete) break;
			}
		} catch {
			inventory.complete = false;
			this.notices.add(
				`Automatic output discovery could not fully inspect ${root}; missing entries are not treated as deleted files.`,
			);
		}
		return inventory;
	}

	private diff(before: Inventory, after: Inventory): ToolOutputFileChange[] {
		const changes: ToolOutputFileChange[] = [];
		const removed = new Map([...before.files].filter(([name]) => !after.files.has(name)));
		const moved = new Set<string>();
		const origins = new Map<string, string[]>();
		for (const [filename, info] of removed) {
			const names = origins.get(info.identity) ?? [];
			names.push(filename);
			origins.set(info.identity, names);
		}
		for (const [filename, info] of after.files) {
			const old = before.files.get(filename);
			if (old) {
				if (
					old.identity !== info.identity ||
					old.size !== info.size ||
					old.modifiedAt !== info.modifiedAt
				)
					changes.push({
						kind: 'update',
						path: filename,
						size: info.size,
						modifiedAt: info.modifiedAt,
					});
				continue;
			}
			const candidates = origins.get(info.identity);
			const previousPath =
				candidates?.length === 1 && !moved.has(candidates[0]) ? candidates[0] : undefined;
			if (previousPath) moved.add(previousPath);
			changes.push({
				kind: previousPath ? 'move' : 'add',
				path: filename,
				...(previousPath ? { previousPath } : {}),
				size: info.size,
				modifiedAt: info.modifiedAt,
			});
		}
		for (const filename of removed.keys())
			if (!moved.has(filename)) changes.push({ kind: 'delete', path: filename });
		return changes;
	}

	private async synchronizeWatchers(): Promise<void> {
		if (this.closed) return;
		const directories = new Set(
			[...this.inventories.values()].flatMap((inventory) => [...inventory.directories]),
		);
		for (const [directory, watcher] of this.watchers)
			if (!directories.has(directory)) {
				watcher.close();
				this.watchers.delete(directory);
			}
		let installed = 0;
		for (const inventory of this.inventories.values())
			for (const directory of inventory.directories) {
				if (this.closed) return;
				if (this.watchers.has(directory)) continue;
				if (this.watchers.size >= this.limits.maxWatchers) {
					this.pollingFallback = true;
					continue;
				}
				try {
					const watcher = watch(directory, { persistent: false }, () => {
						this.dirty++;
					});
					watcher.on('error', () => {
						this.pollingFallback = true;
						this.dirty++;
					});
					this.watchers.set(directory, watcher);
				} catch {
					this.pollingFallback = true;
				}
				if (++installed % 50 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			}
	}

	close(): void {
		this.closed = true;
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
	}
}
