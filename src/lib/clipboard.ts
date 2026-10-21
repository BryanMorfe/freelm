/** Copy locally even when a conversation belongs to a remote workspace. */
export async function copyToClipboard(text: string): Promise<void> {
	if (window.desktop?.clipboardWriteText) {
		await window.desktop.clipboardWriteText(text);
		return;
	}
	await navigator.clipboard.writeText(text);
}
