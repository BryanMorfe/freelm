import type { ToolCallRecord, ToolResult } from '../agent-types';

export type ApprovalDenial = NonNullable<ToolResult['approvalDenied']>;
const LEGACY_DENIAL_SUFFIX = ' Do not retry this action without a new user request.';

function readableReason(text: string): string | undefined {
	text = text.trim();
	if (!text) return;
	if (text.endsWith(LEGACY_DENIAL_SUFFIX))
		text = text.slice(0, -LEGACY_DENIAL_SUFFIX.length).trim();
	try {
		const value: unknown = JSON.parse(text);
		// An older explicit denied record might have stored a JSON error instead of a reason.
		// Keep that raw output in Debug and use only a named readable explanation here.
		if (value && typeof value === 'object') {
			const reason = (value as { reason?: unknown }).reason;
			return typeof reason === 'string' && reason.trim() ? reason : undefined;
		}
	} catch {
		/* Ordinary explanations are plain text. */
	}
	return text || undefined;
}

/** Only explicit authorization outcomes or the old host's exact denial envelope qualify. */
export function approvalDenial(call: ToolCallRecord): ApprovalDenial | undefined {
	const result = call.result;
	if (result?.approvalReviewError && !result.approvalDenied) return;
	if (!result?.isError && call.status !== 'denied') return;
	if (typeof result?.approvalDenied?.reason === 'string' && result.approvalDenied.reason.trim())
		return result.approvalDenied;
	const content = result?.content;
	if (call.status === 'denied') {
		const reason = readableReason(
			content
				?.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('\n') || '',
		);
		return { reason: reason || 'This action was not approved.' };
	}
	if (call.status !== 'failed' || content?.length !== 1 || content[0].type !== 'text') return;
	const text = content[0].text;
	if (!text.endsWith(LEGACY_DENIAL_SUFFIX)) return;
	const reason = readableReason(text);
	if (reason) return { reason };
}
