/** Coalesce rendering work without dropping the last update on EOF, error, or cancellation. */
export function latestStreamUpdates<T>(commit: (value: T) => void, interval = 50) {
	let pending: T | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (pending !== undefined) {
			const next = pending;
			pending = undefined;
			commit(next);
		}
	};
	return {
		push(value: T) {
			pending = value;
			if (timer === undefined) timer = setTimeout(flush, interval);
		},
		flush,
	};
}
