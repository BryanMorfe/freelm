import type {
	WorkflowDataType,
	WorkflowDefinition,
	WorkflowNode,
	WorkflowNodeType,
	WorkflowPort,
} from '../workflow-types';

export interface WorkflowField {
	key: string;
	label: string;
	kind?: 'text' | 'textarea' | 'number' | 'json' | 'select' | 'boolean' | 'lines' | 'secret';
	description?: string;
	placeholder?: string;
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	step?: number;
}
export interface WorkflowNodeDefinition {
	type: WorkflowNodeType;
	title: string;
	description: string;
	category: 'Triggers' | 'AI & media' | 'Actions' | 'Flow control' | 'Data';
	color: string;
	inputs: WorkflowPort[];
	outputs: WorkflowPort[];
	defaults: Record<string, unknown>;
	fields: WorkflowField[];
}
const port = (id: string, label: string, type: WorkflowDataType = 'any'): WorkflowPort => ({
	id,
	label,
	type,
});
const input = port('input', 'Input');
const value = port('value', 'Value');
const text = port('text', 'Text', 'text');
const prompt = port('prompt', 'Prompt', 'text');
const options = (...values: string[]) =>
	values.map((value) => ({
		value,
		label: value
			.split('-')
			.map((part) => part[0].toUpperCase() + part.slice(1))
			.join(' '),
	}));
const promptField: WorkflowField = {
	key: 'prompt',
	label: 'Prompt',
	kind: 'textarea',
	placeholder: 'Write instructions or connect a prompt…',
	description: 'Connected prompt or text is included with these instructions.',
};
const systemField: WorkflowField = {
	key: 'systemPrompt',
	label: 'System instructions',
	kind: 'textarea',
	placeholder: 'How should the model approach this task?',
};
const childField: WorkflowField = { key: 'workflowId', label: 'Child workflow', kind: 'select' };
const modelDefaults = { connectionId: '', model: '', prompt: '' };
export const WORKFLOW_CATALOG: WorkflowNodeDefinition[] = [
	{
		type: 'entry',
		title: 'Manual trigger',
		description: 'Start a run with optional input data.',
		category: 'Triggers',
		color: '#6c9d87',
		inputs: [],
		outputs: [value, text],
		defaults: {},
		fields: [],
	},
	{
		type: 'schedule',
		title: 'Schedule',
		description: 'Start on a recurring interval.',
		category: 'Triggers',
		color: '#6c9d87',
		inputs: [],
		outputs: [value, text],
		defaults: {
			kind: 'interval',
			intervalMinutes: 60,
			missed: 'skip',
			overlap: 'skip',
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			time: '09:00',
			weekdays: [1, 2, 3, 4, 5],
		},
		fields: [
			{
				key: 'kind',
				label: 'Schedule',
				kind: 'select',
				options: options('once', 'interval', 'daily', 'weekly'),
			},
			{ key: 'at', label: 'Date and time', placeholder: '2026-10-17T12:00:00Z' },
			{
				key: 'intervalMinutes',
				label: 'Every (minutes)',
				kind: 'number',
				description: 'Runs while this FreeLM host is open and this workflow is enabled.',
			},
			{ key: 'time', label: 'Local time', placeholder: '09:00' },
			{ key: 'timezone', label: 'Time zone', placeholder: 'America/New_York' },
			{
				key: 'weekdays',
				label: 'Weekdays',
				kind: 'json',
				description: '0 is Sunday, 6 is Saturday.',
			},
			{
				key: 'missed',
				label: 'Missed runs',
				kind: 'select',
				options: [
					{ value: 'skip', label: 'Skip' },
					{ value: 'once', label: 'Run once on return' },
				],
			},
			{
				key: 'overlap',
				label: 'When already running',
				kind: 'select',
				options: [
					{ value: 'skip', label: 'Skip next run' },
					{ value: 'queue', label: 'Queue next run' },
				],
			},
		],
	},
	{
		type: 'event',
		title: 'Event trigger',
		description: 'React to a named workflow event.',
		category: 'Triggers',
		color: '#6c9d87',
		inputs: [],
		outputs: [value, text],
		defaults: { name: 'workflow.event' },
		fields: [
			{ key: 'name', label: 'Event name', placeholder: 'workflow.event' },
			{ key: 'path', label: 'Watch path', description: 'For file.changed events.' },
			{ key: 'debounceMs', label: 'Debounce (milliseconds)', kind: 'number' },
			{ key: 'filter', label: 'Event filter', kind: 'json' },
		],
	},
	{
		type: 'text',
		title: 'Text generation',
		description: 'Generate text or structured JSON.',
		category: 'AI & media',
		color: '#8e98c8',
		inputs: [prompt, port('context', 'Context'), port('images', 'Images', 'image')],
		outputs: [text, value],
		defaults: { ...modelDefaults, responseFormat: 'text', validationRetries: 1 },
		fields: [
			promptField,
			systemField,
			{
				key: 'responseFormat',
				label: 'Response format',
				kind: 'select',
				options: options('text', 'json'),
			},
			{
				key: 'schema',
				label: 'JSON schema',
				kind: 'json',
				description: 'Optional schema when requesting JSON.',
			},
			{
				key: 'validationRetries',
				label: 'Validation retries',
				kind: 'number',
				min: 0,
				max: 2,
				step: 1,
				description: 'Retry an invalid final JSON response up to this many times (0–2).',
			},
		],
	},
	{
		type: 'agent',
		title: 'Agent',
		description: 'Give an agent tools and skills to finish a task.',
		category: 'AI & media',
		color: '#8e98c8',
		inputs: [prompt, port('context', 'Context'), port('images', 'Images', 'image')],
		outputs: [text, value],
		defaults: {
			...modelDefaults,
			tools: [],
			skills: [],
			permissionMode: 'ask',
			responseFormat: 'text',
			validationRetries: 1,
		},
		fields: [
			promptField,
			systemField,
			{
				key: 'responseFormat',
				label: 'Response format',
				kind: 'select',
				options: options('text', 'json'),
			},
			{
				key: 'schema',
				label: 'JSON schema',
				kind: 'json',
				description: 'Validate the final response before downstream nodes receive it.',
			},
			{
				key: 'validationRetries',
				label: 'Validation retries',
				kind: 'number',
				min: 0,
				max: 2,
				step: 1,
				description: 'Retry an invalid final JSON response up to this many times (0–2).',
			},
			{ key: 'projectId', label: 'Project ID', description: 'Optional existing FreeLM project.' },
			{
				key: 'permissionMode',
				label: 'Tool approvals',
				kind: 'select',
				options: [
					{ value: 'ask', label: 'Ask before actions' },
					{ value: 'auto-review', label: 'Automatic review' },
				],
			},
		],
	},
	{
		type: 'image',
		title: 'Image generation',
		description: 'Create images from a prompt or reference.',
		category: 'AI & media',
		color: '#bb91ad',
		inputs: [prompt, port('images', 'Reference', 'image')],
		outputs: [port('images', 'Images', 'image'), value],
		defaults: { ...modelDefaults, size: '1024x1024' },
		fields: [
			promptField,
			{ key: 'size', label: 'Size', placeholder: '1024x1024' },
			{ key: 'quality', label: 'Quality', placeholder: 'Provider default' },
			{ key: 'transparentBackground', label: 'Transparent background', kind: 'boolean' },
		],
	},
	{
		type: 'video',
		title: 'Video generation',
		description: 'Generate video from text and images.',
		category: 'AI & media',
		color: '#bb91ad',
		inputs: [prompt, port('images', 'Reference', 'image')],
		outputs: [port('video', 'Video', 'video'), value],
		defaults: { ...modelDefaults, seconds: 5 },
		fields: [
			promptField,
			{ key: 'seconds', label: 'Duration (seconds)', kind: 'number' },
			{ key: 'size', label: 'Size', placeholder: 'Provider default' },
		],
	},
	{
		type: 'audio',
		title: 'Speech generation',
		description: 'Turn text into spoken audio.',
		category: 'AI & media',
		color: '#bb91ad',
		inputs: [text],
		outputs: [port('audio', 'Audio', 'audio'), value],
		defaults: { ...modelDefaults, voice: 'alloy', format: 'mp3', speed: 1 },
		fields: [
			{ ...promptField, label: 'Text to speak' },
			{ key: 'voice', label: 'Voice', placeholder: 'alloy' },
			{
				key: 'format',
				label: 'Format',
				kind: 'select',
				options: options('mp3', 'wav', 'opus', 'flac'),
			},
			{ key: 'speed', label: 'Speed', kind: 'number' },
		],
	},
	{
		type: 'transcribe',
		title: 'Transcription',
		description: 'Turn an audio file into text.',
		category: 'AI & media',
		color: '#bb91ad',
		inputs: [port('audio', 'Audio', 'audio')],
		outputs: [text, value],
		defaults: { ...modelDefaults },
		fields: [
			{
				key: 'path',
				label: 'Audio file path',
				placeholder: '/path/to/audio.mp3',
				description: 'Or connect an audio input.',
			},
			{ key: 'language', label: 'Language', placeholder: 'Automatic' },
			{ ...promptField, label: 'Transcription guidance' },
		],
	},
	{
		type: 'tool',
		title: 'Tool call',
		description: 'Call a built-in, MCP, or plugin tool.',
		category: 'Actions',
		color: '#c3a171',
		inputs: [input],
		outputs: [value, text],
		defaults: { tool: '', arguments: {} },
		fields: [
			{
				key: 'arguments',
				label: 'Arguments',
				kind: 'json',
				description: 'Input data is available to the tool alongside these arguments.',
			},
			{
				key: 'permissionMode',
				label: 'Tool approvals',
				kind: 'select',
				options: [
					{ value: 'ask', label: 'Ask before actions' },
					{ value: 'auto-review', label: 'Automatic review' },
				],
			},
		],
	},
	{
		type: 'code',
		title: 'Run code',
		description: 'Transform data with JavaScript or Python.',
		category: 'Actions',
		color: '#c3a171',
		inputs: [input],
		outputs: [value, text],
		defaults: { language: 'javascript', code: 'return inputs.input;' },
		fields: [
			{
				key: 'language',
				label: 'Language',
				kind: 'select',
				options: options('javascript', 'python'),
			},
			{
				key: 'code',
				label: 'Code',
				kind: 'textarea',
				description:
					'JavaScript receives inputs and returns a value. Python receives inputs and assigns result.',
			},
		],
	},
	{
		type: 'thread',
		title: 'Thread',
		description: 'Create, read, or continue a FreeLM chat.',
		category: 'Actions',
		color: '#c3a171',
		inputs: [prompt, input, port('threadId', 'Thread ID', 'text')],
		outputs: [text, port('threadId', 'Thread ID', 'text'), value],
		defaults: { action: 'create', kind: 'chat', title: 'Workflow thread' },
		fields: [
			{
				key: 'action',
				label: 'Action',
				kind: 'select',
				options: options('create', 'send', 'read', 'wait', 'archive', 'rename', 'stop'),
			},
			{ key: 'threadId', label: 'Thread ID' },
			{ key: 'title', label: 'Thread title' },
			{ key: 'kind', label: 'Workspace', kind: 'select', options: options('chat', 'code') },
			promptField,
		],
	},
	{
		type: 'condition',
		title: 'Condition',
		description: 'Choose a branch based on a value.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [value, port('compare', 'Compare')],
		outputs: [port('true', 'True'), port('false', 'False')],
		defaults: { operator: 'truthy', compare: '' },
		fields: [
			{
				key: 'operator',
				label: 'Operator',
				kind: 'select',
				options: options('truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'),
			},
			{
				key: 'value',
				label: 'Value',
				kind: 'json',
				description: 'Used when no value is connected.',
			},
			{ key: 'compare', label: 'Compare with', kind: 'json' },
		],
	},
	{
		type: 'foreach',
		title: 'For each',
		description: 'Run a child workflow for every item.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [port('items', 'Items', 'list')],
		outputs: [port('items', 'Results', 'list'), value],
		defaults: { workflowId: '' },
		fields: [
			childField,
			{
				key: 'items',
				label: 'Items',
				kind: 'json',
				description: 'Optional list when no items are connected.',
			},
		],
	},
	{
		type: 'join',
		title: 'Join',
		description: 'Wait for branches and collect their results.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [port('a', 'A'), port('b', 'B'), port('c', 'C')],
		outputs: [value, port('items', 'Items', 'list')],
		defaults: {},
		fields: [],
	},
	{
		type: 'repeat',
		title: 'Repeat',
		description: 'Repeat a child workflow a bounded number of times.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [input, port('count', 'Count', 'number')],
		outputs: [value, port('items', 'Results', 'list')],
		defaults: { workflowId: '', count: 3, maxIterations: 100 },
		fields: [
			childField,
			{ key: 'count', label: 'Repetitions', kind: 'number' },
			{ key: 'maxIterations', label: 'Maximum iterations', kind: 'number' },
		],
	},
	{
		type: 'loop',
		title: 'Feedback loop',
		description: 'Refine a result across rounds until a condition is met.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [input],
		outputs: [
			value,
			port('items', 'Round results', 'list'),
			port('iterations', 'Rounds', 'number'),
			port('stopped', 'Condition met', 'boolean'),
		],
		defaults: {
			workflowId: '',
			maxIterations: 3,
			minIterations: 1,
			resultPath: 'result',
			stopPath: 'done',
			stopOperator: 'truthy',
		},
		fields: [
			{
				...childField,
				description:
					'Each round receives current, previous, iteration, index, and the original run inputs. Current is the preceding round’s result, or the connected input for the first round.',
			},
			{ key: 'maxIterations', label: 'Maximum rounds', kind: 'number', min: 1, max: 100, step: 1 },
			{
				key: 'minIterations',
				label: 'Minimum rounds',
				kind: 'number',
				min: 1,
				max: 100,
				step: 1,
				description: 'The stop condition is checked after this many completed rounds.',
			},
			{
				key: 'resultPath',
				label: 'Result path',
				placeholder: 'result',
				description:
					'Path in the child workflow’s outputs. Leave blank to carry all outputs into the next round.',
			},
			{
				key: 'stopPath',
				label: 'Stop value path',
				placeholder: 'done',
				description: 'Path within the selected round result. Blank checks the entire result.',
			},
			{
				key: 'stopOperator',
				label: 'Stop when',
				kind: 'select',
				options: [
					{ value: 'truthy', label: 'Value is true' },
					{ value: 'equals', label: 'Equals' },
					{ value: 'not-equals', label: 'Does not equal' },
					{ value: 'greater-than', label: 'Greater than' },
					{ value: 'less-than', label: 'Less than' },
					{ value: 'contains', label: 'Contains' },
					{ value: 'empty', label: 'Value is empty' },
					{ value: 'never', label: 'Run every round' },
				],
			},
			{ key: 'stopValue', label: 'Compare with', kind: 'json' },
		],
	},
	{
		type: 'wait',
		title: 'Wait / approval',
		description: 'Pause for a duration or human review.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [input],
		outputs: [value],
		defaults: { mode: 'human', durationMs: 1000 },
		fields: [
			{
				key: 'mode',
				label: 'Wait for',
				kind: 'select',
				options: [
					{ value: 'human', label: 'Human approval' },
					{ value: 'duration', label: 'Duration' },
					{ value: 'until', label: 'Date and time' },
				],
			},
			{ key: 'durationMs', label: 'Duration (milliseconds)', kind: 'number' },
			{ key: 'until', label: 'Date and time', placeholder: '2026-10-17T12:00:00Z' },
			{ key: 'message', label: 'Approval message', kind: 'textarea' },
		],
	},
	{
		type: 'subworkflow',
		title: 'Subworkflow',
		description: 'Reuse another workflow as a single step.',
		category: 'Flow control',
		color: '#839fb5',
		inputs: [input],
		outputs: [value],
		defaults: { workflowId: '' },
		fields: [childField],
	},
	{
		type: 'value',
		title: 'Value',
		description: 'Provide text, a number, a list, or JSON.',
		category: 'Data',
		color: '#a6a070',
		inputs: [],
		outputs: [value],
		defaults: { value: 'Hello, world!' },
		fields: [
			{
				key: 'value',
				label: 'Value',
				kind: 'json',
				description: 'JSON strings, numbers, objects, and arrays are supported.',
			},
		],
	},
	{
		type: 'context',
		title: 'Context',
		description: 'Read files, a thread, or the run input.',
		category: 'Data',
		color: '#a6a070',
		inputs: [input, port('threadId', 'Thread ID', 'text')],
		outputs: [value, text, port('files', 'Files', 'file')],
		defaults: { source: 'run', path: 'inputs' },
		fields: [
			{
				key: 'source',
				label: 'Source',
				kind: 'select',
				options: options('run', 'files', 'thread'),
			},
			{ key: 'path', label: 'Run data path', placeholder: 'inputs.prompt' },
			{
				key: 'paths',
				label: 'File paths',
				kind: 'lines',
				description: 'One absolute file path per line.',
			},
			{ key: 'threadId', label: 'Thread ID' },
		],
	},
	{
		type: 'transform',
		title: 'Transform',
		description: 'Format, parse, extract, or combine data.',
		category: 'Data',
		color: '#a6a070',
		inputs: [input],
		outputs: [value, text],
		defaults: { operation: 'template', template: '{{input}}' },
		fields: [
			{
				key: 'operation',
				label: 'Operation',
				kind: 'select',
				options: options(
					'template',
					'json-parse',
					'json-stringify',
					'get',
					'split',
					'join',
					'merge',
					'pick',
				),
			},
			{
				key: 'template',
				label: 'Template',
				kind: 'textarea',
				description: 'Insert connected values with {{input}} or {{input.field}}.',
			},
			{ key: 'path', label: 'Property path', placeholder: 'items.0.title' },
			{ key: 'separator', label: 'Separator', placeholder: ', ' },
			{ key: 'keys', label: 'Keys to keep', kind: 'lines' },
		],
	},
	{
		type: 'media-transform',
		title: 'Media transform',
		description: 'Resize, crop, or convert an image.',
		category: 'Data',
		color: '#a6a070',
		inputs: [port('media', 'Media', 'image')],
		outputs: [port('images', 'Images', 'image'), value],
		defaults: { operation: 'resize', width: 1024, height: 1024, format: 'png' },
		fields: [
			{
				key: 'operation',
				label: 'Operation',
				kind: 'select',
				options: options('resize', 'crop', 'convert'),
			},
			{ key: 'width', label: 'Width', kind: 'number' },
			{ key: 'height', label: 'Height', kind: 'number' },
			{ key: 'x', label: 'Crop X', kind: 'number' },
			{ key: 'y', label: 'Crop Y', kind: 'number' },
			{ key: 'format', label: 'Format', kind: 'select', options: options('png', 'jpeg', 'webp') },
		],
	},
	{
		type: 'state',
		title: 'State',
		description: 'Read or write a value across workflow runs.',
		category: 'Data',
		color: '#a6a070',
		inputs: [value],
		outputs: [value],
		defaults: { operation: 'get', key: 'counter' },
		fields: [
			{
				key: 'operation',
				label: 'Operation',
				kind: 'select',
				options: options('get', 'set', 'delete'),
			},
			{ key: 'key', label: 'Key' },
			{ key: 'value', label: 'Default value', kind: 'json' },
		],
	},
	{
		type: 'collection',
		title: 'Shared collection',
		description: 'Store and query records shared by related workflow runs.',
		category: 'Data',
		color: '#a6a070',
		inputs: [
			value,
			port('id', 'Record ID', 'text'),
			port('expectedRevision', 'Revision', 'number'),
		],
		outputs: [
			value,
			port('items', 'Values', 'list'),
			port('records', 'Records', 'list'),
			port('record', 'Record', 'object'),
			port('count', 'Count', 'number'),
		],
		defaults: { name: 'records', scope: 'run', operation: 'list', limit: 100, offset: 0 },
		fields: [
			{ key: 'name', label: 'Collection name', placeholder: 'records' },
			{
				key: 'scope',
				label: 'Shared with',
				kind: 'select',
				options: [
					{ value: 'run', label: 'This run and its child runs' },
					{ value: 'workflow', label: 'All runs of this workflow' },
				],
				description:
					'Run collections stay separate for each new investigation. Workflow collections persist across independent runs.',
			},
			{
				key: 'operation',
				label: 'Operation',
				kind: 'select',
				options: [
					{ value: 'list', label: 'List records' },
					{ value: 'get', label: 'Get record' },
					{ value: 'upsert', label: 'Create or update record' },
					{ value: 'append', label: 'Append new record' },
					{ value: 'delete', label: 'Delete record' },
				],
			},
			{ key: 'recordId', label: 'Record ID', description: 'Used when no record ID is connected.' },
			{
				key: 'value',
				label: 'Record data',
				kind: 'json',
				description: 'Used when no value is connected.',
			},
			{
				key: 'expectedRevision',
				label: 'Expected revision',
				kind: 'number',
				min: 0,
				step: 1,
				description:
					'Optional. Reject the update if another writer changed the record. Use 0 to require a new record.',
			},
			{
				key: 'filter',
				label: 'Field filters',
				kind: 'json',
				description:
					'Exact matches on record data, for example {"status":"approved"}. Nested paths use dots.',
			},
			{ key: 'query', label: 'Search text', description: 'Find text within stored record data.' },
			{ key: 'limit', label: 'Maximum records', kind: 'number', min: 1, max: 1000, step: 1 },
			{ key: 'offset', label: 'Skip records', kind: 'number', min: 0, step: 1 },
		],
	},
	{
		type: 'output',
		title: 'Output',
		description: 'Publish a named workflow result.',
		category: 'Actions',
		color: '#6c9d87',
		inputs: [input],
		outputs: [],
		defaults: { name: 'result' },
		fields: [{ key: 'name', label: 'Output name', placeholder: 'result' }],
	},
	{
		type: 'save',
		title: 'Save file',
		description: 'Write text, JSON, or media to a file.',
		category: 'Actions',
		color: '#c3a171',
		inputs: [input],
		outputs: [port('file', 'File', 'file'), value],
		defaults: { path: '', format: 'text' },
		fields: [
			{ key: 'path', label: 'File path', placeholder: '/path/to/output.txt' },
			{
				key: 'format',
				label: 'Format',
				kind: 'select',
				options: options('text', 'json', 'binary'),
			},
		],
	},
	{
		type: 'notify',
		title: 'Notification',
		description: 'Show a desktop notification.',
		category: 'Actions',
		color: '#c3a171',
		inputs: [text, input],
		outputs: [value],
		defaults: { title: 'Workflow finished', message: '' },
		fields: [
			{ key: 'title', label: 'Title' },
			{ key: 'message', label: 'Message', kind: 'textarea' },
		],
	},
];
export const WORKFLOW_NODE_MAP = Object.fromEntries(
	WORKFLOW_CATALOG.map((item) => [item.type, item]),
) as Record<WorkflowNodeType, WorkflowNodeDefinition>;
const unavailableDefinition: WorkflowNodeDefinition = {
	type: 'custom',
	title: 'Custom node',
	description: 'Custom node package unavailable.',
	category: 'Actions',
	color: '#91adb8',
	inputs: [],
	outputs: [],
	defaults: {},
	fields: [],
};
export function definitionForNode(node: WorkflowNode): WorkflowNodeDefinition {
	if (node.type === 'custom' && node.custom?.definition) {
		return { ...unavailableDefinition, ...node.custom.definition, type: 'custom' };
	}
	return WORKFLOW_NODE_MAP[node.type] ?? unavailableDefinition;
}

export const WORKFLOW_PORT_COLORS: Record<WorkflowDataType, string> = {
	any: '#9b9fa6',
	text: '#9a9dce',
	number: '#c6a875',
	boolean: '#c6a875',
	object: '#9cac86',
	list: '#9cac86',
	image: '#c793b0',
	video: '#b48ac8',
	audio: '#b99084',
	file: '#91adb8',
	signal: '#7fac96',
};
export const workflowId = () => crypto.randomUUID();
export function createWorkflowNode(
	type: WorkflowNodeType,
	position: WorkflowNode['position'],
): WorkflowNode {
	const definition = WORKFLOW_NODE_MAP[type];
	return {
		id: workflowId(),
		type,
		label: definition.title,
		position,
		config: structuredClone(definition.defaults),
	};
}
export const WORKFLOW_TEMPLATES = [
	{
		id: 'research-team',
		name: 'Research team',
		description: 'Generate, review, and improve ideas with shared records and feedback rounds.',
		icon: 'research',
	},
	{
		id: 'co-scientist',
		name: 'Co-Scientist',
		description: 'Explore hypotheses with six specialist roles and iterative evidence review.',
		icon: 'research',
	},
	{
		id: 'text-image',
		name: 'Prompt to image',
		description: 'Refine an idea with a text model, then generate an image.',
		icon: 'image',
	},
	{
		id: 'review',
		name: 'Draft and review',
		description: 'Generate a draft, pause for your approval, and publish the result.',
		icon: 'review',
	},
	{
		id: 'data',
		name: 'Transform data',
		description: 'A ready-to-run example using values, a template, and an output.',
		icon: 'data',
	},
	{
		id: 'agent',
		name: 'Agent task',
		description: 'Give an agent instructions, tools, and a reusable output.',
		icon: 'agent',
	},
] as const;
export function createWorkflow(template = 'blank'): WorkflowDefinition {
	const now = Date.now();
	const types: WorkflowNodeType[] =
		template === 'text-image'
			? ['entry', 'text', 'image', 'output']
			: template === 'review'
				? ['entry', 'text', 'wait', 'output']
				: template === 'data'
					? ['value', 'transform', 'output']
					: template === 'agent'
						? ['entry', 'agent', 'output']
						: ['entry', 'output'];
	const nodes = types.map((type, i) => createWorkflowNode(type, { x: 80 + i * 310, y: 150 }));
	if (template === 'data') {
		nodes[0].config.value = { topic: 'your next idea' };
		nodes[1].config.template = 'Make something useful with {{input.topic}}.';
	}
	if (template === 'text-image') {
		nodes[1].config.prompt = 'Write a vivid, concise image prompt based on the input idea.';
		nodes[2].config.prompt = 'Create an image from the connected prompt.';
	}
	if (template === 'review') {
		nodes[1].config.prompt = 'Write a thoughtful draft based on the input.';
		nodes[2].config.message = 'Review the draft before publishing.';
	}
	const edges = nodes.slice(1).map((node, i) => ({
		id: workflowId(),
		source: nodes[i].id,
		target: node.id,
		sourceHandle: nodes[i].type === 'text' ? 'text' : 'value',
		targetHandle: ['text', 'agent', 'image'].includes(node.type) ? 'prompt' : 'input',
	}));
	return {
		version: 1,
		id: workflowId(),
		name: WORKFLOW_TEMPLATES.find((item) => item.id === template)?.name ?? 'Untitled workflow',
		enabled: false,
		nodes,
		edges,
		viewport: { x: 0, y: 0, zoom: 1 },
		createdAt: now,
		updatedAt: now,
	};
}
export function compatibleWorkflowPorts(source: WorkflowDataType, target: WorkflowDataType) {
	return source === 'any' || target === 'any' || source === target;
}
