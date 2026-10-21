import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

async function inspect(directory) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) await inspect(filename);
		else if (/\.[jt]sx$/.test(entry.name)) {
			const source = ts.createSourceFile(
				filename,
				await fs.readFile(filename, 'utf8'),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			function visit(node) {
				if (
					(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
					ts.isIdentifier(node.tagName) &&
					node.tagName.text === 'select'
				) {
					const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
					violations.push(`${path.relative(root, filename)}:${line + 1}`);
				}
				ts.forEachChild(node, visit);
			}
			visit(source);
		}
	}
}

await inspect(path.join(root, 'src'));
if (violations.length) {
	console.error(
		'Use the shared src/components/Select.tsx for dropdowns instead of native <select> elements.',
	);
	console.error(violations.join('\n'));
	process.exitCode = 1;
} else {
	console.log('Shared dropdown component check passed.');
}
