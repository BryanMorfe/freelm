import type { WireResponse } from '../src/types';

/** Chunk delivery and request completion must travel over the same ordered IPC channel. */
export const STREAM_CHANNEL = 'freelm:stream';

export type StreamEvent = { id: string; token: string } & (
	| { type: 'chunk'; text: string }
	| { type: 'complete'; response: WireResponse }
	| { type: 'error'; error: { name: string; message: string } }
);
