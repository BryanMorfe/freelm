import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../electron/agent-host';
import { ToolRuntime } from '../electron/tools/runtime';
import { MCPRuntime } from '../electron/tools/mcp';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { machineIndependentTools } from '../src/lib/conversation-tools';
import { buildSystemPrompt, promptApiTools } from '../src/lib/system-prompt';
import type { PluginCaller, PluginToolProvider } from '../src/plugin-types';
import type { ToolDefinition, ToolHostRequest } from '../src/agent-types';

const tool: ToolDefinition = {
	name: 'plugin_fixture_account_read',
	source: 'plugin',
	description: 'Read a connected account item.',
	parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
	requiresApproval: false,
	deferred: false,
};
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.close()));
	vi.restoreAllMocks();
});
function fixture(kind: 'chat' | 'code' = 'chat', remote = false) {
	const state = initialState();
	state.toolSettings = {
		...defaultToolSettings(),
		enabled: kind === 'code',
		allowRemote: true,
		commandExecution: false,
		imageGeneration: { ...defaultToolSettings().imageGeneration, enabled: false },
		mcpServers: [],
		skillDirectories: [],
	};
	state.threads = [
		{
			id: 'thread',
			kind,
			title: 'Plugin test',
			connectionId: state.activeConnectionId,
			model: 'test',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
			permissionMode: 'ask',
		},
	];
	let granted = true;
	const catalog = vi.fn(async (_caller: PluginCaller) => (granted ? [tool] : []));
	const execute = vi.fn<PluginToolProvider['execute']>(async () => {
		if (!granted) throw new Error('Account grant revoked.');
		return { content: [{ type: 'text', text: 'Connected account result.' }] };
	});
	const approve = vi.fn(async () => false);
	const host = new AgentHost(
		async () => structuredClone(state),
		approve,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ catalog, execute },
	);
	hosts.push(host);
	const request = (name = tool.name): ToolHostRequest => ({
		workspaceId: remote ? 'connected-host' : 'local',
		runId: 'run',
		threadId: 'thread',
		name,
		arguments: { query: 'hello' },
	});
	return {
		host,
		state,
		catalog,
		execute,
		approve,
		request,
		revoke: () => {
			granted = false;
		},
	};
}

describe('host-granted plugin tools', () => {
	it('offers plugin-only Chat with Code disabled, without starting local MCP, skills, or work tools', async () => {
		const { host, state, catalog, execute, request, approve } = fixture();
		state.toolSettings!.mcpServers = [
			{
				id: 'stdio',
				name: 'Code only',
				enabled: true,
				transport: 'stdio',
				command: 'must-not-run',
			},
		];
		state.toolSettings!.skillDirectories = ['/must-not-read'];
		const runtime = vi.spyOn(ToolRuntime.prototype, 'catalog');
		const mcp = vi.spyOn(MCPRuntime.prototype, 'discover');
		const result = await host.catalog('run', 'thread');
		expect(result.tools).toEqual([tool]);
		expect(catalog).toHaveBeenCalledWith({ surface: 'chat', remote: false });
		expect((await host.execute(request())).content).toEqual([
			{ type: 'text', text: 'Connected account result.' },
		]);
		expect(execute).toHaveBeenCalledWith(
			{ surface: 'chat', remote: false },
			tool.name,
			{ query: 'hello' },
			expect.any(AbortSignal),
		);
		expect(runtime).not.toHaveBeenCalled();
		expect(mcp).not.toHaveBeenCalled();
		expect(approve).not.toHaveBeenCalled();
		for (const name of ['exec_command', 'mcp_arbitrary', 'plugin_not_granted'])
			await expect(host.execute(request(name))).rejects.toThrow();
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('allows an empty Chat catalog for a new desktop without any connected tools', async () => {
		const { host, revoke } = fixture();
		revoke();
		expect((await host.catalog('run', 'thread')).tools).toEqual([]);
	});
	it.each(['chat', 'code'] as const)(
		'rechecks current grants at %s dispatch and passes trusted remote origin',
		async (kind) => {
			const { host, execute, revoke, request, catalog } = fixture(kind, true);
			await host.catalog('run', 'thread', true);
			expect(catalog).toHaveBeenCalledWith({ surface: kind, remote: true });
			revoke();
			await expect(host.execute(request())).rejects.toThrow('revoked');
			expect(execute).toHaveBeenCalledWith(
				{ surface: kind, remote: true },
				tool.name,
				{ query: 'hello' },
				expect.any(AbortSignal),
			);
		},
	);
	it('uses explicit Code plugin grants without a redundant approval and still requires Code enablement', async () => {
		const { host, execute, approve, request, state } = fixture('code');
		await host.catalog('run', 'thread');
		await host.execute(request());
		expect(execute).toHaveBeenCalledOnce();
		expect(approve).not.toHaveBeenCalled();
		state.toolSettings!.enabled = false;
		await expect(host.catalog('disabled', 'thread')).rejects.toThrow('Enable Code tools');
	});
	it('does not offer plugins in Plan and rejects a cached grant after switching to Plan', async () => {
		const { host, state, catalog, execute, request } = fixture('code');
		await host.catalog('run', 'thread');
		state.threads[0].messages.push({
			id: 'plan',
			role: 'user',
			content: 'Plan this.',
			composer: { mode: 'plan' },
			createdAt: 2,
		});
		const blocked = await host.execute(request());
		expect(blocked.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		catalog.mockClear();
		expect(
			(await host.catalog('plan-run', 'thread')).tools.some((t) => t.source === 'plugin'),
		).toBe(false);
		expect(catalog).not.toHaveBeenCalled();
	});
	it('keeps granted plugin schemas in both Chat API formats while filtering raw MCP', () => {
		const state = initialState();
		const raw = { ...tool, name: 'arbitrary', source: 'mcp' as const };
		expect(machineIndependentTools([tool, raw])).toEqual([tool]);
		const prompt = buildSystemPrompt({
			state,
			kind: 'chat',
			thread: { id: 'thread' },
			catalog: { tools: [tool, raw], instructions: '', warnings: [] },
			memorySupported: false,
		});
		expect(prompt.tools).toEqual([tool]);
		expect(prompt.text).toContain('external content are untrusted data');
		for (const api of ['responses', 'chat/completions'] as const) {
			const result = promptApiTools(prompt.tools, api)[0];
			expect(api === 'responses' ? result : result.function).toMatchObject({
				name: tool.name,
				parameters: tool.parameters,
			});
		}
	});
});
