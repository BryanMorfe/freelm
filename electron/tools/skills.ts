import { createHash } from 'node:crypto';
import { lstat, readFile, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { ToolResult } from '../../src/agent-types';
import { boundedNumber, requiredString, safePath, textResult } from './common';

const MAX_SKILL_BYTES = 256 * 1024;
export interface SkillMetadata {
	id: string;
	name: string;
	description: string;
	path: string;
}
interface Skill extends SkillMetadata {
	root: string;
}

export class SkillsRuntime {
	private skills = new Map<string, Skill>();
	private configuration = '';

	async discover(directories: string[]): Promise<{ skills: SkillMetadata[]; warnings: string[] }> {
		const configuration = JSON.stringify(directories);
		const discovered = new Map<string, Skill>();
		const warnings: string[] = [];
		for (const configured of [...new Set(directories)].slice(0, 32)) {
			if (discovered.size >= 256) break;
			try {
				if (!path.isAbsolute(configured)) throw new Error('Use an absolute directory path.');
				const root = await realpath(configured);
				if (!(await stat(root)).isDirectory()) throw new Error('Not a directory.');
				let roots: string[];
				try {
					await lstat(path.join(root, 'SKILL.md'));
					roots = [root];
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					const directory = await opendir(root);
					roots = [];
					let scanned = 0;
					try {
						while (scanned < 1_024 && roots.length < 256) {
							const entry = await directory.read();
							if (!entry) break;
							scanned++;
							if (entry.isDirectory() && !entry.name.startsWith('.'))
								roots.push(path.join(root, entry.name));
						}
					} finally {
						await directory.close();
					}
					roots.sort((a, b) => a.localeCompare(b));
					if (scanned >= 1_024 || roots.length >= 256)
						warnings.push(
							`Skills directory ${configured}: discovery is bounded; configure narrower directories if skills are missing.`,
						);
				}
				for (const skillRoot of roots) {
					if (discovered.size >= 256) break;
					try {
						const file = await safePath(root, path.join(skillRoot, 'SKILL.md'));
						const info = await lstat(file);
						if (!info.isFile() || info.size > MAX_SKILL_BYTES)
							throw new Error('SKILL.md must be a regular file smaller than 256 KiB.');
						const source = await readFile(file, 'utf8');
						const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
						let metadata: Record<string, unknown> = {};
						if (frontmatter) {
							const document = parseDocument(frontmatter, { uniqueKeys: true });
							if (document.errors.length) throw new Error('Invalid YAML frontmatter.');
							const value = document.toJS({ maxAliasCount: 0 });
							if (value && typeof value === 'object' && !Array.isArray(value)) metadata = value;
						}
						const id = createHash('sha256').update(file).digest('hex').slice(0, 16);
						discovered.set(id, {
							id,
							root: skillRoot,
							path: file,
							name:
								typeof metadata.name === 'string'
									? metadata.name.slice(0, 150)
									: path.basename(skillRoot),
							description:
								typeof metadata.description === 'string'
									? metadata.description.slice(0, 1200)
									: 'No description provided.',
						});
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
							warnings.push(`Skill ${path.basename(skillRoot)}: ${(error as Error).message}`);
					}
				}
			} catch (error) {
				warnings.push(`Skills directory ${configured}: ${(error as Error).message}`);
			}
		}
		this.skills = discovered;
		this.configuration = configuration;
		if (discovered.size >= 256)
			warnings.push(
				'Skill discovery is limited to 256 skills. Configure narrower skill directories if needed.',
			);
		return {
			skills: [...discovered.values()].map(({ root: _root, ...metadata }) => metadata),
			warnings,
		};
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
		directories: string[],
	): Promise<ToolResult> {
		if (this.configuration !== JSON.stringify(directories)) await this.discover(directories);
		if (name === 'skills.list') {
			const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
			return textResult(
				[...this.skills.values()]
					.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query))
					.map(({ root: _root, ...metadata }) => metadata),
			);
		}
		const id = requiredString(args, 'skill', 200);
		const matches = [...this.skills.values()].filter(
			(skill) => skill.id === id || skill.name === id,
		);
		if (matches.length !== 1)
			throw new Error(
				'Skill not found or its name is ambiguous. Use a skill ID returned by skills.list.',
			);
		const skill = matches[0];
		const relative = typeof args.path === 'string' ? args.path : 'SKILL.md';
		const file = await safePath(skill.root, relative);
		const info = await lstat(file);
		if (!info.isFile() || info.size > MAX_SKILL_BYTES)
			throw new Error('Skill resources must be regular text files smaller than 256 KiB.');
		const data = await readFile(file);
		const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
		if (content.includes('\0')) throw new Error('This skill resource is not a text file.');
		const lines = content.split('\n');
		const start = boundedNumber(args.start_line, 1, 1, Math.max(1, lines.length));
		const count = boundedNumber(args.line_count, 300, 1, 1000);
		const selected = lines.slice(start - 1, start - 1 + count).join('\n');
		const max = 64_000;
		return textResult({
			skill: skill.id,
			path: path.relative(skill.root, file),
			start_line: start,
			total_lines: lines.length,
			content: selected.slice(0, max),
			truncated: selected.length > max || start - 1 + count < lines.length,
		});
	}
}
