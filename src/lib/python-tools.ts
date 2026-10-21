import type { ToolDefinition, ToolSettings } from '../agent-types';

export const pythonTool: ToolDefinition = {
	name: 'python.exec',
	displayName: 'Run Python',
	source: 'builtin',
	description:
		'Execute Python for calculations, data analysis, and creating downloadable files or plots. Variables persist in this conversation until the sandbox is reset or idle. The isolated interpreter cannot access the user’s files, network, or shell. Save outputs in the current directory; new or changed files are returned automatically. Only installed libraries are available.',
	parameters: {
		type: 'object',
		properties: {
			code: {
				type: 'string',
				description: 'Python source to run. The last expression is displayed.',
			},
			timeout_ms: {
				type: 'integer',
				minimum: 100,
				maximum: 120000,
				description:
					'Execution deadline in milliseconds; defaults to 30000. Timeout resets this interpreter.',
			},
		},
		required: ['code'],
		additionalProperties: false,
	},
};

export const pythonInstructions =
	'Use python.exec for exact calculations and self-contained data analysis. It is a separate, isolated Python interpreter, not local command execution. It has no user-file, network, shell, or package-install access. Variables persist per conversation while the session remains active; cancellation, timeout, or idle cleanup resets them. Save deliverables in the current directory, using plain filenames, to return downloadable files or images. Check available libraries before relying on them. Do not claim code ran or a file exists without a successful tool result.';

export function configuredPython(settings: ToolSettings): boolean {
	return settings.pythonExecution?.enabled === true;
}
