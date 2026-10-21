import type { ToolDefinition, ToolResult } from '../agent-types';
import { DEFAULT_VIDEO_SIZE } from './video-resolution';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
});
const string = { type: 'string' };
export const interactionTools: ToolDefinition[] = [
	{
		name: 'update_plan',
		source: 'builtin',
		description: 'Show and update a short task checklist. At most one step may be in progress.',
		parameters: object(
			{
				explanation: string,
				plan: {
					type: 'array',
					minItems: 1,
					maxItems: 30,
					items: object(
						{
							step: string,
							status: { enum: ['pending', 'in_progress', 'completed'], type: 'string' },
						},
						['step', 'status'],
					),
				},
			},
			['plan'],
		),
	},
	{
		name: 'request_user_input',
		source: 'builtin',
		description:
			'Ask the user one to three concise questions and wait for their answers. Options are suggestions; the user can write a different answer.',
		parameters: object(
			{
				questions: {
					type: 'array',
					minItems: 1,
					maxItems: 3,
					items: object(
						{
							id: string,
							header: string,
							question: string,
							options: {
								type: 'array',
								maxItems: 6,
								items: object({ label: string, description: string }, ['label', 'description']),
							},
						},
						['id', 'question'],
					),
				},
			},
			['questions'],
		),
	},
	{
		name: 'send_message_to_user_async',
		source: 'builtin',
		description: 'Display a brief progress message to the user without waiting for a reply.',
		parameters: object({ message: string }, ['message']),
	},
	{
		name: 'clock.curr_time',
		source: 'builtin',
		description: 'Get the current UTC time.',
		parameters: object({}),
	},
	{
		name: 'clock.sleep',
		source: 'builtin',
		description:
			'Wait briefly. Stopping the run interrupts the wait. duration_ms is limited to 60000.',
		parameters: object({ duration_ms: { type: 'integer', minimum: 1, maximum: 60000 } }, [
			'duration_ms',
		]),
	},
];
export const imageTool: ToolDefinition = {
	name: 'image_gen.imagegen',
	source: 'builtin',
	displayName: 'Generate image',
	description:
		'Generate or edit an image using the image model configured in FreeLM Settings. For edits choose either up to five referenced_image_paths in the workspace or num_last_images_to_include from recent chat images. Return the generated image to the user.',
	parameters: object(
		{
			prompt: string,
			size: {
				type: 'string',
				maxLength: 128,
				description:
					'Optional output size: WIDTHxHEIGHT in pixels, or auto. Overrides the saved default for this call. Use the configured image model guidance to choose dimensions.',
			},
			transparent_background: { type: 'boolean' },
			referenced_image_paths: { type: 'array', minItems: 1, maxItems: 5, items: string },
			num_last_images_to_include: { type: 'integer', minimum: 1, maximum: 5 },
		},
		['prompt'],
	),
};
export const videoTool: ToolDefinition = {
	name: 'video_gen.videogen',
	source: 'builtin',
	displayName: 'Generate video',
	description:
		'Generate a video using the video model configured in FreeLM Settings. Optionally animate one recent attached image with num_last_images_to_include: 1, or one workspace image with referenced_image_paths. Choose only one reference mechanism. The tool waits for the provider job to finish, applies configured input and output moderation, and returns a playable video file. Generation may take hours; do not repeat a pending call.',
	parameters: object(
		{
			prompt: { type: 'string', minLength: 1, maxLength: 100000 },
			size: {
				type: 'string',
				maxLength: 128,
				description: `Optional output dimensions WIDTHxHEIGHT in pixels. Each dimension is rounded to the nearest multiple of 32. Omit to use the saved default, falling back to ${DEFAULT_VIDEO_SIZE}. An explicit size is always sent to the provider. Request only resolutions supported by the selected model.`,
			},
			seconds: {
				anyOf: [
					{ type: 'number', exclusiveMinimum: 0 },
					{ type: 'string', maxLength: 32 },
				],
				description:
					'Optional duration in seconds as a positive number or numeric string. Omit to use the saved default or provider default. Request a duration supported by the selected model.',
			},
			referenced_image_paths: { type: 'array', minItems: 1, maxItems: 1, items: string },
			num_last_images_to_include: { type: 'integer', minimum: 1, maximum: 1 },
		},
		['prompt'],
	),
};
export const textResult = (value: unknown): ToolResult => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export interface UserQuestion {
	id: string;
	question: string;
	options: { label: string; description?: string }[];
}
export function userQuestions(args: Record<string, unknown>): UserQuestion[] {
	if (!Array.isArray(args.questions) || !args.questions.length || args.questions.length > 3)
		throw new Error('Ask one to three questions.');
	const ids = new Set<string>();
	return args.questions.map((raw: unknown) => {
		const q = raw as Record<string, unknown>;
		if (
			!q ||
			typeof q.id !== 'string' ||
			!q.id ||
			ids.has(q.id) ||
			typeof q.question !== 'string' ||
			!q.question.trim() ||
			q.question.length > 10000
		)
			throw new Error('Each question needs a unique ID and question text.');
		ids.add(q.id);
		const options = q.options ?? [];
		if (
			!Array.isArray(options) ||
			options.length > 6 ||
			!options.every(
				(o) =>
					o &&
					typeof o.label === 'string' &&
					o.label.trim() &&
					o.label.length < 1000 &&
					(o.description === undefined || typeof o.description === 'string'),
			)
		)
			throw new Error('Invalid answer options.');
		return { id: q.id, question: q.question, options };
	});
}
export async function executeInteraction(
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ToolResult> {
	if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
	if (name === 'update_plan') {
		if (
			!Array.isArray(args.plan) ||
			!args.plan.length ||
			args.plan.length > 30 ||
			!args.plan.every(
				(s) =>
					s &&
					typeof s.step === 'string' &&
					s.step.trim() &&
					s.step.length <= 1000 &&
					['pending', 'in_progress', 'completed'].includes(s.status),
			) ||
			args.plan.filter((s) => s.status === 'in_progress').length > 1
		)
			throw new Error('Provide up to 30 steps with at most one step in progress.');
		return textResult({
			plan: args.plan,
			...(typeof args.explanation === 'string'
				? { explanation: args.explanation.slice(0, 10000) }
				: {}),
		});
	}
	if (name === 'send_message_to_user_async') {
		if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 10000)
			throw new Error('A brief nonempty message is required.');
		return textResult(args.message);
	}
	if (name === 'clock.curr_time') return textResult({ current_time: new Date().toISOString() });
	if (name === 'clock.sleep') {
		if (
			!Number.isInteger(args.duration_ms) ||
			Number(args.duration_ms) < 1 ||
			Number(args.duration_ms) > 60000
		)
			throw new Error('duration_ms must be 1–60000.');
		const start = Date.now();
		await new Promise<void>((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', abort);
				reject(new DOMException('Cancelled', 'AbortError'));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', abort);
				resolve();
			}, Number(args.duration_ms));
			signal.addEventListener('abort', abort, { once: true });
		});
		return textResult({ elapsed_ms: Date.now() - start });
	}
	throw new Error(`Unknown interaction tool: ${name}`);
}
