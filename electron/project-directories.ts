import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { suggestedProjectDirectoryName } from '../src/lib/project-directories';

/** Host-only creation. The renderer supplies a title, never a destination directory. */
export async function createProjectDirectory(
	name: unknown,
	baseDirectory = path.join(homedir(), 'Documents', 'FreeLM'),
): Promise<string> {
	if (typeof name !== 'string' || !name.trim() || name.length > 512)
		throw new Error('Enter a project name of up to 512 characters.');
	const leaf = suggestedProjectDirectoryName(name);
	const base = path.resolve(baseDirectory);
	try {
		await mkdir(base, { recursive: true });
	} catch {
		throw new Error(
			`FreeLM could not create its projects folder at ${base}. Check folder permissions or choose an existing directory.`,
		);
	}
	for (let attempt = 1; attempt <= 1000; attempt++) {
		const directory = path.join(base, attempt === 1 ? leaf : `${leaf} ${attempt}`);
		try {
			// Deliberately non-recursive: existing folders, files and symlinks must not be reused.
			await mkdir(directory);
			return directory;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
			throw new Error(
				`FreeLM could not create the project directory at ${directory}. Check folder permissions or choose an existing directory.`,
			);
		}
	}
	throw new Error(
		'Too many project directories share this name. Choose another project name or an existing directory.',
	);
}
