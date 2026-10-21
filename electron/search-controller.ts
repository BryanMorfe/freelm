import type { SearchServiceStatus, ToolSettings } from '../src/agent-types';
import { normalizedSearchSettings, type SearchSettings } from '../src/lib/search-settings';
import { searxngSearchUrl } from '../src/lib/web-tools';

interface ManagedSearch {
	status(): SearchServiceStatus;
	start(engines: string[]): Promise<SearchServiceStatus>;
	restart(engines: string[]): Promise<SearchServiceStatus>;
	stop(): Promise<SearchServiceStatus>;
	close(): Promise<void>;
}

/** Only the host's saved search configuration controls its bundled process. */
export class SearchController {
	private queue: Promise<unknown> = Promise.resolve();
	private previous?: SearchSettings;
	private closed = false;
	private stopVersion = 0;
	private activeStarts = 0;
	constructor(
		private readonly service: ManagedSearch,
		private readonly load: () => Promise<ToolSettings['webBrowsing']>,
	) {}
	status(): SearchServiceStatus {
		return this.service.status();
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(() => {
			if (this.closed) throw new Error('FreeLM search is shutting down.');
			return operation();
		});
		this.queue = next.catch(() => {});
		return next;
	}
	private async startService(engines: string[], restart = false): Promise<SearchServiceStatus> {
		this.activeStarts++;
		try {
			return await (restart ? this.service.restart(engines) : this.service.start(engines));
		} finally {
			this.activeStarts--;
		}
	}
	start(): Promise<SearchServiceStatus> {
		const version = this.stopVersion;
		return this.serialize(async () => {
			const settings = normalizedSearchSettings(await this.load());
			if (version !== this.stopVersion) return this.status();
			if (settings.mode !== 'builtin')
				throw new Error('Select built-in search and save before starting the service.');
			return this.startService(settings.engines);
		});
	}
	stop(): Promise<SearchServiceStatus> {
		this.stopVersion++;
		return this.service.stop();
	}
	/** Call after a successful save, or once at application startup. */
	async update(): Promise<SearchServiceStatus> {
		let version = this.stopVersion;
		// Read outside the lifecycle queue so a saved disable/external change can
		// cancel readiness immediately instead of waiting for its startup deadline.
		const settings = normalizedSearchSettings(await this.load());
		if (this.closed) throw new Error('FreeLM search is shutting down.');
		let cancellation: Promise<{ error?: unknown }> | undefined;
		if ((settings.mode !== 'builtin' || !settings.enabled) && version === this.stopVersion) {
			version = ++this.stopVersion;
			if (
				this.activeStarts ||
				['starting', 'running', 'stopping'].includes(this.status().phase) ||
				JSON.stringify(this.previous) !== JSON.stringify(settings)
			) {
				cancellation = this.service.stop().then(
					() => ({}),
					(error: unknown) => ({ error }),
				);
			}
		}
		return this.serialize(async () => {
			const stopped = await cancellation;
			if (stopped && Object.hasOwn(stopped, 'error')) throw stopped.error;
			const previous = this.previous;
			this.previous = settings;
			if (version !== this.stopVersion) return this.status();
			if (previous && JSON.stringify(previous) === JSON.stringify(settings)) return this.status();
			if (settings.mode !== 'builtin' || !settings.enabled) return this.status();
			const running = ['running', 'starting'].includes(this.status().phase);
			if (
				running &&
				previous &&
				JSON.stringify(previous.engines) !== JSON.stringify(settings.engines)
			)
				return this.startService(settings.engines, true);
			if (
				!running &&
				settings.autoStart &&
				(!previous || !previous.autoStart || !previous.enabled || previous.mode !== 'builtin')
			)
				return this.startService(settings.engines);
			return this.status();
		});
	}
	resolve(settings: NonNullable<ToolSettings['webBrowsing']>): string {
		if (!settings.enabled) throw new Error('Enable browsing in Settings → Search.');
		if (settings.mode !== 'builtin') return searxngSearchUrl(settings.searxngUrl).href;
		const status = this.status();
		if (status.phase !== 'running' || !status.url)
			throw new Error(
				status.message || 'Start the built-in search service in Settings → Search before browsing.',
			);
		return status.url;
	}
	async close(): Promise<void> {
		this.closed = true;
		await this.service.close();
		await this.queue;
	}
}
