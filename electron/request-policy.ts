import { Agent } from 'undici';

export const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

// A cold model may be silent before headers or between streaming chunks.
// Node fetch's default five-minute HTTP timers must not shorten our deadline.
export const requestDispatcher = new Agent({
	headersTimeout: REQUEST_TIMEOUT_MS,
	bodyTimeout: REQUEST_TIMEOUT_MS,
});

// Remote video tools wait for an asynchronous provider job. Cancellation and
// disconnection end the request; an ordinary inference timeout must not kill it.
export const longRunningToolDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export type RequestOptions = RequestInit & { dispatcher: Agent };
