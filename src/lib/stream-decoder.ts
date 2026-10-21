type ResponseSource = 'API' | 'remote instance';
export type DecodingFailure = 'invalid-utf8' | 'incomplete-utf8';

/** Safe to show in diagnostics: never includes response content or a decoder cause. */
export class ResponseDecodingError extends Error {
	constructor(
		readonly kind: DecodingFailure,
		source: ResponseSource,
	) {
		super(
			kind === 'incomplete-utf8'
				? `The ${source} response ended with an incomplete UTF-8 character. Retry the request; if this repeats, check the provider or proxy stream.`
				: `The ${source} response contains invalid UTF-8 text. Check the provider or proxy encoding and retry.`,
		);
		this.name = 'ResponseDecodingError';
	}
}

/** Retains split code points between chunks, but never silently inserts replacement characters. */
export function createUtf8Decoder(source: ResponseSource = 'API') {
	const decoder = new TextDecoder('utf-8', { fatal: true });
	return {
		push(bytes: Uint8Array): string {
			try {
				return decoder.decode(bytes, { stream: true });
			} catch {
				throw new ResponseDecodingError('invalid-utf8', source);
			}
		},
		finish(): string {
			try {
				return decoder.decode();
			} catch {
				throw new ResponseDecodingError('incomplete-utf8', source);
			}
		},
	};
}

export function decodeUtf8(bytes: Uint8Array, source: ResponseSource = 'API'): string {
	const decoder = createUtf8Decoder(source);
	return decoder.push(bytes) + decoder.finish();
}
