const DEFAULT_ERROR = 'Something went wrong. Please try again.';

function extractMessage(value: unknown, depth = 0): string {
	if (depth > 6 || value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value !== 'object') return '';
	if (Array.isArray(value))
		return value
			.slice(0, 20)
			.map((item) => extractMessage(item, depth + 1))
			.filter(Boolean)
			.join('\n');
	const record = value as Record<string, unknown>;
	for (const key of ['message', 'error', 'detail', 'error_description']) {
		const message = extractMessage(record[key], depth + 1);
		if (message.trim()) return message;
	}
	if (typeof record.msg === 'string') {
		const path = Array.isArray(record.loc)
			? record.loc.filter((part) => typeof part === 'string' || typeof part === 'number').join('.')
			: '';
		return path ? `${path}: ${record.msg}` : record.msg;
	}
	return '';
}

/**
 * Presentation only: retain the original error in state, logs and Debug views.
 * Accept saved strings as well as exceptions so old failures render consistently.
 * Never apply this to ordinary assistant prose, source code or process output.
 */
export function userFacingError(error: unknown, fallback = DEFAULT_ERROR): string {
	let message = extractMessage(error).trim();
	// A Python exception's explanation follows its traceback. Keep that last
	// explanation, not source paths, source lines or the traceback heading.
	const traceback = message.indexOf('Traceback (most recent call last):');
	if (traceback >= 0) {
		const lines = message.slice(traceback).split('\n');
		const cause = [...lines]
			.reverse()
			.find((line) => /^(?:[\w.]+(?:Error|Exception)|Error|Exception):\s*\S/.test(line));
		if (cause) return userFacingError(message.slice(0, traceback) + cause, fallback);
		message = message.slice(0, traceback).trim();
	}
	for (let pass = 0; pass < 8; pass++) {
		const previous = message;
		message = message
			.replace(/Error invoking remote method\s+(['"])[^'"\r\n]+\1:\s*/gi, '')
			.replace(
				/(^|:\s*|\n\s*)(?:(?:[A-Za-z_$][\w$]*\.)*(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error|Exception)):\s*/g,
				'$1',
			)
			.trim();
		// Providers sometimes put a JSON error envelope after an HTTP status.
		const envelope = message.match(
			/^((?:(?:API|HTTP)\s+\d{3}(?:\s+[^:{\n]+)?\s*:\s*)?)([\[{][\s\S]*)$/i,
		);
		if (envelope) {
			try {
				const extracted = extractMessage(JSON.parse(envelope[2]));
				if (extracted) message = envelope[1] + extracted;
				else message = envelope[1].trim() ? `${envelope[1]}${fallback}` : fallback;
			} catch {
				// Not an error envelope; retain the provider's useful explanation.
			}
		}
		if (message === previous) break;
	}
	message = message
		.split('\n')
		.filter(
			(line) =>
				!/^\s*at\s+(?:async\s+)?(?:.+\([^\n]*\)|\S+:\d+(?::\d+)?|\S+\s+\[as\s+[^\]]+\])\s*$/.test(
					line,
				),
		)
		.join('\n')
		.replace(/\s*\((?:E[A-Z_]{3,}|ERR_[A-Z_]+)(?:\s*[,;]\s*-?\d+)?\)/g, '')
		.trim();
	if (!message || /^(?:undefined|null|\[object Object\])$/.test(message)) return fallback;
	if (
		/^(?:Failed to fetch|fetch failed|Network request failed|Load failed|NetworkError when attempting to fetch resource\.?|(?:connect\s+)?(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b.*|net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)\b.*)$/i.test(
			message,
		)
	)
		return 'Could not connect. Check the server address and your network connection, then try again.';
	if (/^(?:(?:connect\s+)?ETIMEDOUT\b.*|net::ERR_TIMED_OUT\b.*)$/i.test(message))
		return 'The request took too long to respond. Check that the server is available, then try again.';
	if (
		/^(?:Cannot (?:read|set) propert(?:y|ies)\b|[\w$]+(?:[.\[\]\w$\x27\x22])* is not (?:a function|defined)\.?$|Object has been destroyed\.?$)/.test(
			message,
		)
	)
		return fallback;
	return message;
}
