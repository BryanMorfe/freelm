interface Options {
	text?: string[];
	title?: string;
	width?: number;
	height?: number;
	links?: string[];
	javascript?: boolean;
}

/** A small valid PDF assembled locally; it has no fetched fonts or images. */
export function webPdfFixture(options: Options = {}): Uint8Array {
	const text = options.text ?? [
		'First PDF page, with searchable evidence.',
		'Second page, with independent text.',
	];
	const escape = (value: string) => value.replace(/[\\()]/g, '\\$&').replace(/\r?\n/g, ' ');
	const objects: string[] = [];
	objects.push(
		`<< /Type /Catalog /Pages 2 0 R ${options.javascript ? '/OpenAction << /S /JavaScript /JS (globalThis.PDF_SCRIPT_EXECUTED = true) >>' : ''} >>`,
	);
	objects.push('');
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	const pages: number[] = [];
	for (const [index, content] of text.entries()) {
		const page = objects.length + 1;
		const stream = page + 1;
		const annotations: number[] = [];
		pages.push(page);
		objects.push('');
		const operations = `BT /F1 12 Tf 40 120 Td (${escape(content)}) Tj ET`;
		objects.push(
			`<< /Length ${Buffer.byteLength(operations)} >>\nstream\n${operations}\nendstream`,
		);
		for (const url of options.links ?? (index === 0 ? ['https://example.com/source'] : [])) {
			annotations.push(objects.length + 1);
			objects.push(
				`<< /Type /Annot /Subtype /Link /Rect [40 110 200 140] /A << /S /URI /URI (${escape(url)}) >> >>`,
			);
		}
		objects[page - 1] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.width ?? 300} ${options.height ?? 180}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R ${annotations.length ? `/Annots [${annotations.map((id) => `${id} 0 R`).join(' ')}]` : ''} >>`;
	}
	objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] >>`;
	objects.push(`<< /Title (${escape(options.title ?? 'FreeLM PDF fixture')}) >>`);
	let output = '%PDF-1.7\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	output += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('');
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new Uint8Array(Buffer.from(output));
}
