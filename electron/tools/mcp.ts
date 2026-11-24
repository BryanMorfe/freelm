import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
	MCPServerConfig,
	ToolContent,
	ToolDefinition,
	ToolResult,
} from '../../src/agent-types';
import { boundedNumber, checkAbort, requiredString, textResult } from './common';

const STARTUP_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_TOOLS = 256;
const MAX_TEXT = 128_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 12 * 1024 * 1024;

const boundedFetch: typeof fetch = async (input, init) => {
	const response = await fetch(input, { ...init, redirect: 'error' });
	if (!response.body) return response;
	let size = 0;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				size += chunk.byteLength;
				if (size > MAX_HTTP_RESPONSE_BYTES)
					throw new Error('MCP HTTP response exceeded the 12 MiB limit.');
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
};

interface Connection {
	config: MCPServerConfig;
	fingerprint: string;
	client: Client;
	transport: Transport;
	tools: Map<string, { original: string; definition: ToolDefinition }>;
}

export function mcpToolName(serverId: string, original: string): string {
	const label = `${serverId}_${original}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 39);
	const hash = createHash('sha256')
		.update(JSON.stringify([serverId, original]))
		.digest('hex')
		.slice(0, 12);
	return `mcp_${label}_${hash}`;
}

function limited(text: string): string {
	return text.length <= MAX_TEXT
		? text
		: `${text.slice(0, MAX_TEXT)}\n[Result truncated at ${MAX_TEXT} characters.]`;
}

/** Preserve image results as media; never silently render arbitrary server HTML. */
export function convertMCPResult(value: Record<string, unknown>): ToolResult {
	const content: ToolContent[] = [];
	let remaining = MAX_TEXT;
	let imageBytes = 0;
	const addText = (text: string) => {
		if (remaining <= 0) return;
		const value = text.slice(0, remaining);
		content.push({ type: 'text', text: value });
		remaining -= value.length;
		if (value.length < text.length)
			content.push({ type: 'text', text: '\n[MCP result text truncated.]' });
	};
	const blocks = Array.isArray(value.content)
		? value.content
		: Array.isArray(value.contents)
			? value.contents
			: [];
	for (const raw of blocks.slice(0, 64)) {
		if (!raw || typeof raw !== 'object') continue;
		const block = raw as Record<string, unknown>;
		if (
			block.type === 'image' &&
			typeof block.data === 'string' &&
			typeof block.mimeType === 'string' &&
			/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)
		) {
			const bytes = Buffer.byteLength(block.data, 'base64');
			if (bytes + imageBytes <= MAX_IMAGE_BYTES) {
				content.push({ type: 'image', dataUrl: `data:${block.mimeType};base64,${block.data}` });
				imageBytes += bytes;
			} else addText('[MCP image omitted because the result exceeds the 8 MiB image limit.]');
		} else if (typeof block.text === 'string') addText(block.text);
		else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
			const resource = block.resource as Record<string, unknown>;
			addText(
				JSON.stringify({
					...resource,
					...(resource.blob ? { blob: '[Binary resource omitted]' } : {}),
				}),
			);
		} else if (block.type === 'resource_link') addText(JSON.stringify(block));
		else
			addText(
				JSON.stringify({
					...block,
					...(block.data ? { data: '[Binary content omitted]' } : {}),
					...(block.blob ? { blob: '[Binary content omitted]' } : {}),
				}),
			);
	}
	if (value.structuredContent !== undefined)
		addText(JSON.stringify({ structuredContent: value.structuredContent }));
	if (!content.length) addText('MCP request completed with no content.');
	return { content, ...(value.isError === true ? { isError: true } : {}) };
}

export class MCPRuntime {
	private connections = new Map<string, Connection>();
	private pending = new Map<
		string,
		{ controller: AbortController; promise: Promise<Connection> }
	>();
	private lifetime = new AbortController();
	private reconciliation = Promise.resolve();

	async discover(
		configs: MCPServerConfig[],
		signal?: AbortSignal,
	): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
		let result!: { tools: ToolDefinition[]; warnings: string[] };
		const operation = this.reconciliation.then(async () => {
			const abort = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
			checkAbort(abort);
			const enabled = configs.filter((config) => config.enabled);
			if (enabled.length > 16) throw new Error('Configure no more than 16 enabled MCP servers.');
			if (new Set(enabled.map((config) => config.id)).size !== enabled.length)
				throw new Error('MCP server IDs must be unique.');
			for (const [id, connection] of this.connections) {
				const config = enabled.find((item) => item.id === id);
				if (!config || connection.fingerprint !== JSON.stringify(config)) {
					this.connections.delete(id);
					await connection.client.close().catch(() => {});
				}
			}
			const tools: ToolDefinition[] = [];
			const warnings: string[] = [];
			await Promise.all(
				enabled.map(async (config) => {
					// Bound the entire discovery, including pagination, to 30 seconds per server.
					const serverAbort = AbortSignal.any([abort, AbortSignal.timeout(LIST_TIMEOUT_MS)]);
					try {
						const connection = await this.connection(config, serverAbort);
						connection.tools.clear();
						if (!connection.client.getServerCapabilities()?.tools) return;
						let cursor: string | undefined;
						const seen = new Set<string>();
						do {
							const page = await connection.client.listTools(cursor ? { cursor } : {}, {
								signal: serverAbort,
								timeout: LIST_TIMEOUT_MS,
							});
							for (const tool of page.tools) {
								if (connection.tools.size >= MAX_TOOLS) break;
								if (JSON.stringify(tool.inputSchema).length > MAX_TEXT) {
									warnings.push(
										`${config.name}: skipped ${tool.name} because its schema exceeds 128,000 characters.`,
									);
									continue;
								}
								const name = mcpToolName(config.id, tool.name);
								const definition: ToolDefinition = {
									name,
									displayName: `${config.name}: ${tool.name}`,
									description: `${config.name} MCP server: ${(tool.description || tool.name).slice(0, 8000)}`,
									parameters: tool.inputSchema as Record<string, unknown>,
									source: 'mcp',
									requiresApproval: true,
									deferred: true,
								};
								connection.tools.set(name, { original: tool.name, definition });
							}
							cursor = page.nextCursor;
							if (cursor && seen.has(cursor))
								throw new Error('Server repeated a tools pagination cursor.');
							if (cursor) seen.add(cursor);
						} while (cursor && connection.tools.size < MAX_TOOLS && seen.size < 32);
						if (cursor)
							warnings.push(
								`${config.name}: the tool catalog was limited to ${MAX_TOOLS} tools / 32 pages.`,
							);
						tools.push(...[...connection.tools.values()].map((entry) => entry.definition));
					} catch (error) {
						warnings.push(`${config.name}: ${limited((error as Error).message)}`);
						const failed = this.connections.get(config.id);
						if (failed) {
							this.connections.delete(config.id);
							await failed.client.close().catch(() => {});
						}
					}
				}),
			);
			checkAbort(abort);
			result = { tools: tools.sort((a, b) => a.name.localeCompare(b.name)), warnings };
		});
		this.reconciliation = operation.catch(() => {});
		await operation;
		return result;
	}

	private async connection(config: MCPServerConfig, signal: AbortSignal): Promise<Connection> {
		const fingerprint = JSON.stringify(config);
		const existing = this.connections.get(config.id);
		if (existing?.fingerprint === fingerprint) return existing;
		const pending = this.pending.get(config.id);
		if (pending) return pending.promise;
		const controller = new AbortController();
		const abort = AbortSignal.any([signal, controller.signal, this.lifetime.signal]);
		const promise = this.start(config, fingerprint, abort)
			.then((connection) => {
				checkAbort(abort);
				this.connections.set(config.id, connection);
				return connection;
			})
			.finally(() => this.pending.delete(config.id));
		this.pending.set(config.id, { controller, promise });
		return promise;
	}

	private async start(
		config: MCPServerConfig,
		fingerprint: string,
		signal: AbortSignal,
	): Promise<Connection> {
		checkAbort(signal);
		if (!config.id || !config.name) throw new Error('MCP servers need an ID and display name.');
		let transport: Transport;
		if (config.transport === 'stdio') {
			if (!config.command) throw new Error('A stdio MCP server requires a command.');
			const stdio = new StdioClientTransport({
				command: config.command,
				args: config.args ?? [],
				env: { ...getDefaultEnvironment(), ...config.env },
				stderr: 'pipe',
				maxBufferSize: 12 * 1024 * 1024,
			});
			// Drain stderr without sending potentially sensitive diagnostics to the model or app logs.
			stdio.stderr?.on('data', () => {});
			transport = stdio;
		} else if (config.transport === 'http') {
			const url = new URL(config.url || '');
			if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
				throw new Error('MCP URL must use HTTP(S) without embedded credentials.');
			const headers: Record<string, string> = {};
			if (config.bearerTokenEnv) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.bearerTokenEnv))
					throw new Error('Bearer token environment variable name is invalid.');
				const token = process.env[config.bearerTokenEnv];
				if (!token)
					throw new Error(`The host environment variable ${config.bearerTokenEnv} is not set.`);
				headers.Authorization = `Bearer ${token}`;
			}
			transport = new StreamableHTTPClientTransport(url, {
				requestInit: { headers },
				fetch: boundedFetch,
				reconnectionOptions: {
					maxRetries: 0,
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 1000,
					reconnectionDelayGrowFactor: 1,
				},
			});
		} else throw new Error('Unsupported MCP transport.');
		const client = new Client({ name: 'FreeLM', version: '0.1.0' }, { capabilities: {} });
		const close = () => {
			void client.close().catch(() => {});
		};
		signal.addEventListener('abort', close, { once: true });
		try {
			await client.connect(transport, { signal, timeout: STARTUP_TIMEOUT_MS });
			checkAbort(signal);
			const connection: Connection = { config, fingerprint, client, transport, tools: new Map() };
			client.onclose = () => {
				if (this.connections.get(config.id) === connection) this.connections.delete(config.id);
			};
			return connection;
		} catch (error) {
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
			throw error;
		} finally {
			signal.removeEventListener('abort', close);
		}
	}

	search(args: Record<string, unknown>): ToolResult {
		const query = requiredString(args, 'query', 1000).toLowerCase();
		const words = query.split(/\s+/).filter(Boolean);
		const definitions = [...this.connections.values()].flatMap((connection) =>
			[...connection.tools.values()].map((tool) => tool.definition),
		);
		const found = definitions
			.map((definition) => {
				const name = `${definition.name} ${definition.displayName}`.toLowerCase();
				const description = definition.description.toLowerCase();
				return {
					definition,
					score: words.reduce(
						(score, word) => score + (name.includes(word) ? 4 : description.includes(word) ? 1 : 0),
						0,
					),
				};
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name))
			.slice(0, boundedNumber(args.limit, 8, 1, 20))
			.map((item) => item.definition);
		return {
			...textResult({
				tools: found,
				message: found.length
					? 'These tools are available on the next assistant turn.'
					: 'No matching MCP tools were found. Try another query.',
			}),
			discoveredTools: found,
		};
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
		configs: MCPServerConfig[],
		signal: AbortSignal,
	): Promise<ToolResult> {
		checkAbort(signal);
		for (const connection of this.connections.values()) {
			if (
				!configs.some(
					(config) =>
						config.enabled &&
						config.id === connection.config.id &&
						JSON.stringify(config) === connection.fingerprint,
				)
			)
				continue;
			const tool = connection.tools.get(name);
			if (!tool) continue;
			const result = await connection.client.callTool(
				{ name: tool.original, arguments: args },
				undefined,
				{ signal, timeout: CALL_TIMEOUT_MS },
			);
			return convertMCPResult(result as Record<string, unknown>);
		}
		throw new Error(
			'MCP tool is unavailable. Refresh the tool catalog after changing server settings.',
		);
	}

	async resources(
		name: string,
		args: Record<string, unknown>,
		configs: MCPServerConfig[],
		signal: AbortSignal,
	): Promise<ToolResult> {
		checkAbort(signal);
		const server = typeof args.server === 'string' ? args.server : undefined;
		const enabled = configs.filter((config) => config.enabled && (!server || config.id === server));
		if (!enabled.length)
			throw new Error('No matching enabled MCP server. Use the server ID from the tool catalog.');
		if (name === 'read_mcp_resource' && enabled.length !== 1)
			throw new Error('Specify the MCP server ID when reading a resource.');
		if (args.cursor && !server)
			throw new Error('Specify the MCP server ID when continuing a resource page.');
		const results = await Promise.all(
			enabled.map(async (config) => {
				try {
					const connection = this.connections.get(config.id);
					if (!connection || connection.fingerprint !== JSON.stringify(config))
						throw new Error(
							`MCP server ${config.name} is not connected. Refresh its catalog first.`,
						);
					const options = { signal, timeout: LIST_TIMEOUT_MS };
					const cursor = typeof args.cursor === 'string' ? { cursor: args.cursor } : {};
					if (name === 'read_mcp_resource') {
						const result = await connection.client.readResource(
							{ uri: requiredString(args, 'uri', 8000) },
							options,
						);
						return convertMCPResult(result as Record<string, unknown>);
					}
					if (!connection.client.getServerCapabilities()?.resources)
						return textResult({
							server: config.id,
							[name === 'list_mcp_resources' ? 'resources' : 'resourceTemplates']: [],
						});
					const result =
						name === 'list_mcp_resources'
							? await connection.client.listResources(cursor, options)
							: await connection.client.listResourceTemplates(cursor, options);
					return textResult(limited(JSON.stringify({ server: config.id, ...result })));
				} catch (error) {
					return textResult({ server: config.id, error: limited((error as Error).message) }, true);
				}
			}),
		);
		checkAbort(signal);
		return {
			content: results.flatMap((result) => result.content),
			...(results.some((result) => result.isError) ? { isError: true } : {}),
		};
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		for (const pending of this.pending.values()) pending.controller.abort();
		const connections = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(connections.map((connection) => connection.client.close()));
		await Promise.allSettled([...this.pending.values()].map((pending) => pending.promise));
	}
}
