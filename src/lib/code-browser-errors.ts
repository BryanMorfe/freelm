import { userFacingError } from './user-facing-error';

/** Add browser-specific recovery to the shared error presentation. */
export function codeBrowserError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error || '');
	if (/HTTP.*HTTPS|unsupported.*protocol|invalid.*url/i.test(message))
		return 'Enter a website address or a local development URL, such as http://localhost:3000. Open local HTML files in Files to preview them.';
	if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED/i.test(message))
		return 'Could not connect to this page. If it is a local app, start its development server, check the port, then reload.';
	if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message))
		return 'This address could not be found. Check the spelling and your network connection, then try again.';
	if (
		/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH/i.test(
			message,
		)
	)
		return 'This page is unreachable. Check your network connection and the address, then reload.';
	if (/ERR_CERT_|ERR_SSL_/i.test(message))
		return 'This site’s secure connection could not be verified. Check the address or fix the server certificate before trying again.';
	if (/ERR_TIMED_OUT|ETIMEDOUT/i.test(message))
		return 'The page took too long to respond. Check that the server is running, then reload.';
	if (
		/ERR_|Object has been destroyed|Invalid browser|Browser unavailable|Unsupported browser action/i.test(
			message,
		)
	)
		return 'The browser could not complete that action. Reload the page, or close this tab and open it again.';
	return userFacingError(error, 'The browser could not complete that action. Try again.');
}

/** File URLs are routed back through Code's scoped file reader, never loaded by the browser. */
export function codeBrowserLocalPath(input: string): string | undefined {
	const value = input.trim();
	if (value.startsWith('/') && !value.startsWith('//')) return value;
	if (!/^file:/i.test(value)) return;
	try {
		const url = new URL(value);
		if (url.hostname && url.hostname !== 'localhost') return;
		const path = decodeURIComponent(url.pathname);
		return path.startsWith('/') && !/[\x00-\x1f]/.test(path) ? path : undefined;
	} catch {
		return;
	}
}
