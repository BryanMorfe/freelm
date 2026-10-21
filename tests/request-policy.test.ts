import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { performRequest } from '../electron/transport';
import { InstanceClient } from '../electron/instance-client';
import { requestDispatcher } from '../electron/request-policy';
import type { WireRequest } from '../src/types';

// Undici exposes this clock specifically for testing its HTTP header/body timers.
// Advance its actual dispatcher, without sleeping or changing the overall deadline.
const httpClock = createRequire(import.meta.url)('undici/lib/util/timers.js') as {
	tick(milliseconds?: number): void;
};
const servers: Server[] = [];
const clients: InstanceClient[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	clients.splice(0).forEach((client) => client.disconnect());
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

async function server(handler: RequestListener) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const wire: WireRequest = {
	id: 'cold-start',
	connectionId: 'provider',
	baseUrl: 'http://unused.test/v1',
	apiKey: '',
	path: '/responses',
	method: 'POST',
	body: { model: 'cold-model', input: 'Hello' },
	stream: true,
};

async function paired(url: string) {
	const { client } = await InstanceClient.connect({
		name: 'Host',
		transport: 'direct',
		url,
		token: 'test-token',
	});
	clients.push(client);
	return client;
}

function info(response: ServerResponse) {
	response.setHeader('Content-Type', 'application/json');
	response.end(JSON.stringify({ protocol: 1, instanceId: 'host', name: 'Host' }));
}

describe('cold-start HTTP timeouts', () => {
	it('allows a provider to remain silent before response headers for 29 minutes', async () => {
		const dispatch = vi.spyOn(requestDispatcher, 'dispatch');
		let accept!: (response: ServerResponse) => void;
		const accepted = new Promise<ServerResponse>((resolve) => (accept = resolve));
		const url = await server((_request, response) => accept(response));
		let settled = false;
		const pending = performRequest({ ...wire, baseUrl: url + '/v1' }, () => {});
		void pending.then(
			() => (settled = true),
			() => (settled = true),
		);
		const response = await accepted;
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ path: '/v1/responses' }),
			expect.any(Object),
		);
		httpClock.tick();
		httpClock.tick(29 * 60 * 1000);
		await setImmediate();
		await setImmediate();
		expect(settled).toBe(false);
		response.setHeader('Content-Type', 'application/json');
		response.end('{"output_text":"Loaded"}');
		await expect(pending).resolves.toMatchObject({ status: 200, body: '{"output_text":"Loaded"}' });
	});

	it('allows a remote generation stream to remain silent for 29 minutes', async () => {
		const dispatch = vi.spyOn(requestDispatcher, 'dispatch');
		let response: ServerResponse;
		const url = await server((request, reply) => {
			if (request.url === '/info') return info(reply);
			response = reply;
			reply.setHeader('Content-Type', 'application/x-ndjson');
			reply.write(JSON.stringify({ type: 'chunk', text: 'starting' }) + '\n');
		});
		const client = await paired(url);
		let started!: () => void;
		const streaming = new Promise<void>((resolve) => (started = resolve));
		let settled = false;
		const pending = client.request(wire, () => started());
		void pending.then(
			() => (settled = true),
			() => (settled = true),
		);
		await streaming;
		expect(dispatch).toHaveBeenLastCalledWith(
			expect.objectContaining({ path: '/request' }),
			expect.any(Object),
		);
		httpClock.tick();
		httpClock.tick(29 * 60 * 1000);
		await setImmediate();
		await setImmediate();
		expect(settled).toBe(false);
		response!.end(
			JSON.stringify({
				type: 'response',
				response: { status: 200, contentType: 'text/event-stream', body: '', encoding: 'text' },
			}) + '\n',
		);
		await expect(pending).resolves.toMatchObject({ status: 200 });
	});

	it('still cancels a silent remote stream when its 30-minute overall deadline expires', async () => {
		const url = await server((request, response) => {
			if (request.url === '/info') return info(response);
			response.setHeader('Content-Type', 'application/x-ndjson');
			response.write(JSON.stringify({ type: 'chunk', text: 'starting' }) + '\n');
		});
		const client = await paired(url);
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
		let started!: () => void;
		const streaming = new Promise<void>((resolve) => (started = resolve));
		const pending = client.request(wire, () => started());
		await streaming;
		expect(timeout).toHaveBeenCalledWith(1_800_000);
		const reason = new DOMException('Timed out waiting for the remote API.', 'TimeoutError');
		deadline.abort(reason);
		await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
	});
});
