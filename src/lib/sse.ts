/** Incremental SSE parser supporting CRLF, multiline data, and split network chunks. */
export function createSSEParser(onEvent: (data: string, event: string) => void) {
	let buffer = '';
	let data: string[] = [];
	let event = '';
	function line(value: string) {
		if (value === '') {
			if (data.length) onEvent(data.join('\n'), event);
			data = [];
			event = '';
			return;
		}
		if (value.startsWith(':')) return;
		const colon = value.indexOf(':');
		const key = colon < 0 ? value : value.slice(0, colon);
		let valuePart = colon < 0 ? '' : value.slice(colon + 1);
		if (valuePart.startsWith(' ')) valuePart = valuePart.slice(1);
		if (key === 'data') data.push(valuePart);
		else if (key === 'event') event = valuePart;
	}
	return {
		push(chunk: string) {
			buffer += chunk;
			let boundary: RegExpExecArray | null;
			while ((boundary = /\r\n|\n|\r(?!$)/.exec(buffer))) {
				line(buffer.slice(0, boundary.index));
				buffer = buffer.slice(boundary.index + boundary[0].length);
			}
		},
		finish() {
			if (buffer) line(buffer.replace(/\r$/, ''));
			buffer = '';
			line('');
		},
	};
}
