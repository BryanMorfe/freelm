import { describe, expect, it } from 'vitest';
import { unavailableToolMessage, type ToolAvailabilityEntry } from '../src/lib/tool-availability';

const note: ToolAvailabilityEntry = {
	name: 'notes_append_to_file',
	apiName: 'notes_append_to_file',
	source: 'builtin',
};
const search: ToolAvailabilityEntry = {
	name: 'tool_search',
	apiName: 'tool_search',
	source: 'builtin',
};

describe('tool availability recovery', () => {
	it('does not recommend an unoffered discovery tool', () => {
		const error = unavailableToolMessage('missing', [note]);
		expect(error).toContain('No tool-discovery function is offered');
		expect(error).toContain('No action was run');
		expect(error).not.toContain('tool_search');
		expect(error).toContain('"requestedName":"missing"');
		expect(error).toContain('"canonicalName":null');
		expect(error).toContain('"offeredCount":1');
	});

	it('offers discovery only when the builtin discovery tool is in this request', () => {
		expect(unavailableToolMessage('missing', [note, search])).toContain('Use "tool_search"');
		expect(unavailableToolMessage('missing', [note, { ...search, source: 'mcp' }])).toContain(
			'No tool-discovery function is offered',
		);
	});

	it('suggests exact offered names without implicitly enabling a namespaced alias', () => {
		const error = unavailableToolMessage('functions.notes_append_to_file', [note]);
		expect(error).toContain('Use the exact offered API name "notes_append_to_file" in a new call');
		expect(error).toContain('"requestedName":"functions.notes_append_to_file"');
		expect(error).toContain('"canonicalName":"notes_append_to_file"');
		expect(error).not.toContain('tool_search');
	});

	it('explains provider aliases and the next-request discovery boundary', () => {
		const mcp: ToolAvailabilityEntry = {
			name: 'mcp.docs.lookup',
			apiName: 'mcp_docs_lookup_hash',
			source: 'mcp',
		};
		expect(unavailableToolMessage(mcp.name, [mcp])).toContain(
			'Use the exact offered API name "mcp_docs_lookup_hash"',
		);
		const error = unavailableToolMessage(mcp.apiName, [search], [mcp]);
		expect(error).toContain('discovered after the current request');
		expect(error).toContain('cannot run in this call batch');
		expect(error).not.toContain('Use "tool_search"');
	});

	it('bounds diagnostics and includes names only, never schemas or arguments', () => {
		const catalog = Array.from({ length: 128 }, (_, i) => ({
			...note,
			name: `notes_${i}`,
			apiName: `notes_${i}`,
			parameters: { secret: 'schema-secret' },
			description: 'description-secret',
		}));
		const error = unavailableToolMessage('x'.repeat(512), catalog);
		expect(error.length).toBeLessThan(1400);
		expect(error).toContain('"offeredCount":128');
		expect(error).toContain('"omittedNames":116');
		expect(error).not.toContain('notes_12');
		expect(error).not.toContain('secret');
	});
});
