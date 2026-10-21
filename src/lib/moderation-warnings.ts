/** Bound host warnings before rendering or persisting them as plain text. */
export function validModerationWarnings(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 8 &&
		value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 2048)
	);
}
