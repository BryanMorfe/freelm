import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ToolResult, ToolSettings } from '../src/agent-types';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { ToolRuntime } from '../electron/tools/runtime';
import { convertMCPResult, mcpToolName } from '../electron/tools/mcp';

function fixtureResponse(method: string, params: Record<string, unknown> = {}): unknown {
	if (method === 'initialize')
		return {
			protocolVersion: '2025-03-26',
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: 'FreeLM fixture', version: '1' },
		};
	if (method === 'tools/list')
		return params.cursor === 'page-two'
			? {
					tools: [
						{
							name: 'waiting',
							description: 'Wait until cancelled',
							inputSchema: { type: 'object', properties: {} },
						},
					],
				}
			: {
					tools: [
						{
							name: 'echo',
							description: 'Echo fixture text',
							inputSchema: {
								type: 'object',
								properties: { text: { type: 'string' } },
								required: ['text'],
							},
						},
					],
					nextCursor: 'page-two',
				};
	if (method === 'tools/call' && params.name === 'echo')
		return {
			content: [{ type: 'text', text: (params.arguments as { text: string }).text }],
			structuredContent: { echoed: true },
		};
	if (method === 'tools/call' && params.name === 'waiting') return undefined;
	if (method === 'resources/list')
		return { resources: [{ uri: 'fixture://example', name: 'example', mimeType: 'text/plain' }] };
	if (method === 'resources/templates/list')
		return { resourceTemplates: [{ uriTemplate: 'fixture://{name}', name: 'fixture template' }] };
	if (method === 'resources/read')
		return { contents: [{ uri: params.uri, text: 'Fixture resource contents' }] };
	return {};
}

const resultText = (result: ToolResult) =>
	result.content
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');

describe('host MCP runtime', () => {
	let directory: string;
	let runtime: ToolRuntime;
	let settings: ToolSettings;
	let server: Server | undefined;
	const execute = (
		name: string,
		args: Record<string, unknown>,
		signal = new AbortController().signal,
	) =>
		runtime.execute(
			{ workspaceId: 'local', threadId: 'thread', runId: 'run', name, arguments: args },
			settings,
			signal,
		);

	beforeEach(async () => {
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'freelm-tool-host-mcp-')));
		runtime = new ToolRuntime();
		settings = { ...defaultToolSettings(), enabled: true };
	});
	afterEach(async () => {
		await runtime.close();
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
		await rm(directory, { recursive: true, force: true });
	});

	async function stdio(): Promise<void> {
		const file = path.join(directory, 'fixture-server.cjs');
		await writeFile(
			file,
			`const readline = require('node:readline');\nconst respond = ${fixtureResponse.toString()};\nreadline.createInterface({input: process.stdin}).on('line', line => { const message = JSON.parse(line); if (message.id === undefined) return; const result = respond(message.method, message.params); if (result !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n'); });\n`,
		);
		settings.mcpServers = [
			{
				id: 'fixture',
				name: 'Fixture',
				enabled: true,
				transport: 'stdio',
				command: process.execPath,
				args: [file],
			},
		];
	}

	it('discovers paginated stdio tools, defers schemas, searches, and calls tools', async () => {
		await stdio();
		const catalog = await runtime.catalog(settings);
		expect(catalog.warnings).toEqual([]);
		const tools = catalog.tools.filter((tool) => tool.source === 'mcp');
		expect(tools).toHaveLength(2);
		expect(tools.every((tool) => tool.requiresApproval && tool.deferred)).toBe(true);
		const search = await execute('tool_search', { query: 'echo' });
		expect(search.discoveredTools).toHaveLength(1);
		const result = await execute(search.discoveredTools![0].name, { text: 'hello from fixture' });
		expect(resultText(result)).toContain('hello from fixture');
		expect(resultText(result)).toContain('structuredContent');
		expect((await execute('mcp_unknown', {})).isError).toBe(true);
	});

	it('lists resource templates and reads resources from the selected server', async () => {
		await stdio();
		await runtime.catalog(settings);
		expect(resultText(await execute('list_mcp_resources', {}))).toContain('fixture://example');
		expect(
			resultText(await execute('list_mcp_resource_templates', { server: 'fixture' })),
		).toContain('fixture://{name}');
		expect(
			resultText(
				await execute('read_mcp_resource', { server: 'fixture', uri: 'fixture://example' }),
			),
		).toContain('Fixture resource contents');
	});

	it('aborts an in-flight MCP call and invalidates removed servers', async () => {
		await stdio();
		await runtime.catalog(settings);
		const waiting = execute(mcpToolName('fixture', 'waiting'), {});
		runtime.cancel('run');
		expect(resultText(await waiting)).toContain('cancelled');
		const prior = mcpToolName('fixture', 'echo');
		settings.mcpServers = [];
		await runtime.catalog(settings);
		expect((await execute(prior, { text: 'cannot run' })).isError).toBe(true);
	});

	it('closes a stdio server that never finishes initialization', async () => {
		const marker = path.join(directory, 'started');
		const file = path.join(directory, 'hanging-fixture.cjs');
		await writeFile(
			file,
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); require('node:readline').createInterface({input:process.stdin}).on('line',()=>{});`,
		);
		settings.mcpServers = [
			{
				id: 'hanging',
				name: 'Hanging fixture',
				enabled: true,
				transport: 'stdio',
				command: process.execPath,
				args: [file],
			},
		];
		const pending = runtime.catalog(settings).catch((error: Error) => error);
		await expect.poll(async () => readFile(marker, 'utf8').catch(() => '')).toBe('started');
		await runtime.close();
		expect(await pending).toBeInstanceOf(Error);
	});

	it('connects a Streamable HTTP fixture with a host environment bearer token', async () => {
		const requests: string[] = [];
		server = createServer(async (request, response) => {
			requests.push(request.headers.authorization || '');
			if (request.method !== 'POST') {
				response.writeHead(405);
				response.end();
				return;
			}
			let body = '';
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body);
			if (message.id === undefined) {
				response.writeHead(202);
				response.end();
				return;
			}
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: message.id,
					result: fixtureResponse(message.method, message.params),
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server!.once('error', reject);
			server!.listen(0, '127.0.0.1', resolve);
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Fixture did not listen.');
		const previous = process.env.FREELM_MCP_FIXTURE_TOKEN;
		process.env.FREELM_MCP_FIXTURE_TOKEN = 'fixture-token';
		try {
			settings.mcpServers = [
				{
					id: 'http',
					name: 'HTTP fixture',
					enabled: true,
					transport: 'http',
					url: `http://127.0.0.1:${address.port}/mcp`,
					bearerTokenEnv: 'FREELM_MCP_FIXTURE_TOKEN',
				},
			];
			const catalog = await runtime.catalog(settings);
			expect(catalog.warnings).toEqual([]);
			expect(JSON.stringify(catalog)).not.toContain('fixture-token');
			expect(
				resultText(await execute(mcpToolName('http', 'echo'), { text: 'http works' })),
			).toContain('http works');
			expect(requests.length).toBeGreaterThan(2);
			expect(requests.every((header) => header === 'Bearer fixture-token')).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.FREELM_MCP_FIXTURE_TOKEN;
			else process.env.FREELM_MCP_FIXTURE_TOKEN = previous;
		}
	});

	it('reports malformed server configuration without exposing configured environment values', async () => {
		settings.mcpServers = [
			{
				id: 'bad',
				name: 'Bad server',
				enabled: true,
				transport: 'http',
				url: 'file:///tmp/anything',
				env: { INTERNAL: 'never-in-catalog' },
			},
		];
		const catalog = await runtime.catalog(settings);
		expect(catalog.warnings[0]).toContain('HTTP(S)');
		expect(JSON.stringify(catalog)).not.toContain('never-in-catalog');
	});
});

it('keeps tool names collision-safe and MCP content bounded', () => {
	expect(mcpToolName('server-a', 'tool.b')).not.toBe(mcpToolName('server-a', 'tool_b'));
	expect(mcpToolName('x'.repeat(100), 'y'.repeat(100)).length).toBeLessThanOrEqual(64);
	const result = convertMCPResult({
		content: [
			{ type: 'text', text: 'x'.repeat(200_000) },
			{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
		],
		isError: true,
	});
	expect(result.isError).toBe(true);
	expect(resultText(result).length).toBeLessThan(128_100);
	expect(result.content.some((item) => item.type === 'image')).toBe(true);
});
