import { composerVisibleText, validMentionIcon } from './composer-mention-codec';
import type { ComposerContext } from '../composer-types';
import type { Message } from '../types';
import { createCodeGoal, type CodeGoal } from './code-goals';

/** This validates storage shape only. The execution host validates every path/skill. */
export function validComposerContext(value: unknown): value is ComposerContext {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const context = value as ComposerContext;
	if (Object.keys(context).some((key) => !['mode', 'references'].includes(key))) return false;
	return (
		(context.mode === undefined || context.mode === 'goal' || context.mode === 'plan') &&
		(context.references === undefined ||
			(Array.isArray(context.references) &&
				context.references.length <= 30 &&
				context.references.every(
					(ref) =>
						!!ref &&
						typeof ref === 'object' &&
						['file', 'folder', 'skill', 'app'].includes(ref.kind) &&
						(ref.icon === undefined || (ref.kind === 'app' && validMentionIcon(ref.icon))) &&
						Object.keys(ref).every((key) =>
							['kind', 'id', 'label', 'path', 'token', 'icon'].includes(key),
						) &&
						['id', 'label', 'path', 'token'].every((key) => {
							const field = ref[key as 'id' | 'label' | 'path' | 'token'];
							return (
								typeof field === 'string' &&
								field.length > 0 &&
								field.length <= 16000 &&
								!field.includes('\0')
							);
						}),
				)))
	);
}

export { latestComposerMode } from './code-plan';

/** Goal mode represents an explicit human request; ordinary messages never create goals. */
export function composerGoal(
	previous: CodeGoal | undefined,
	messages: readonly Pick<Message, 'content' | 'composer'>[],
): CodeGoal | undefined {
	let goal = previous;
	for (const message of messages) {
		if (message.composer?.mode === 'goal')
			goal = createCodeGoal(goal, composerVisibleText(message.content));
	}
	return goal;
}
