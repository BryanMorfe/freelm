import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	ComposerContextHost,
	validateComposerDiscovery,
	type ComposerHostScope,
} from '../electron/composer-context';
import { createComposerMention } from '../src/lib/composer-mention-codec';
import type { ComposerDiscoveryRequest, ComposerSuggestion } from '../src/composer-types';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { StateStore } from '../electron/state-store';
import { initialState } from '../src/lib/state';
import { defaultToolSettings } from '../src/lib/tool-settings';

const cleanup: string[] = [];
afterEach(async () => {
	for (const filename of cleanup.splice(0)) await rm(filename, { recursive: true, force: true });
});
async function fixture() {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'freelm-composer-host-')));
	cleanup.push(directory);
	const first = path.join(directory, 'first'),
		second = path.join(directory, 'second'),
		skills = path.join(directory, 'skills');
	await Promise.all([first, second, skills].map((filename) => mkdir(filename)));
	const scope: ComposerHostScope = {
		kind: 'code',
		roots: [first, second],
		skillDirectories: [skills],
		allowRemote: true,
	};
	const host = new ComposerContextHost(async () => structuredClone(scope));
	const discover = (query = '', kind: 'files' | 'skills' = 'files') =>
		host.discover({ workspaceId: 'local', conversationKind: 'code', kind, query });
	const select = (item: ComposerSuggestion) => {
		const reference = createComposerMention(item);
		scope.message = {
			id: 'user',
			content: `Please use ${reference.token}`,
			references: [reference],
		};
		return reference;
	};
	return { directory, first, second, skills, scope, host, discover, select };
}
const query: ComposerDiscoveryRequest = {
	workspaceId: 'local',
	conversationKind: 'code',
	kind: 'files',
	query: '',
};

describe('Code composer host references', () => {
	it('finds and resolves distinct same-named files in multiple bound directories without reading their contents', async () => {
		const { first, second, discover, select, host } = await fixture();
		await Promise.all(
			[first, second].map((root) =>
				writeFile(path.join(root, 'report.md'), 'PRIVATE FILE CONTENT'),
			),
		);
		const results = await discover('report');
		expect(results.items).toHaveLength(2);
		expect(new Set(results.items.map((item) => item.id)).size).toBe(2);
		expect(new Set(results.items.map((item) => item.description)).size).toBe(2);
		select(results.items[1]);
		const context = await host.resolve('thread', 'user');
		expect(context.instructions).toContain(second);
		expect(context.instructions).toContain('contents have not been read');
		expect(context.instructions).not.toContain('PRIVATE FILE CONTENT');
	});
	it('supports explicit folder paths beyond the general scan depth and handles punctuation in file names', async () => {
		const { first, discover, select, host } = await fixture();
		const deep = path.join(first, 'one/two/three/four/five/six');
		await mkdir(deep, { recursive: true });
		await writeFile(path.join(deep, "what's (new).md"), 'hello');
		const results = await discover('one/two/three/four/five/six/');
		const file = results.items.find((item) => item.label === "what's (new).md")!;
		expect(file).toBeDefined();
		select(file);
		expect((await host.resolve('thread', 'user')).instructions).toContain("what's (new).md");
	});
	it('omits dependency and hidden directories from broad searches while allowing deliberately typed regular paths', async () => {
		const { first, discover } = await fixture();
		await mkdir(path.join(first, 'node_modules'));
		await mkdir(path.join(first, '.hidden'));
		await writeFile(path.join(first, 'node_modules/dependency.js'), 'dependency');
		await writeFile(path.join(first, '.hidden/context.md'), 'context');
		expect((await discover('dependency')).items).toEqual([]);
		expect((await discover('context')).items).toEqual([]);
		expect((await discover('.hidden/context.md')).items[0].label).toBe('context.md');
	});
	it('does not grant scope through traversal, sibling roots, symlinks or caller-selected identities', async () => {
		const { directory, first, discover, host, select, scope } = await fixture();
		await writeFile(path.join(directory, 'outside.md'), 'outside');
		await writeFile(path.join(first, 'inside.md'), 'inside');
		await symlink(directory, path.join(first, 'escape'));
		expect((await discover('../outside.md')).items).toEqual([]);
		expect((await discover('escape/outside.md')).items).toEqual([]);
		const selected = select((await discover('inside')).items[0]);
		const forged = createComposerMention({ ...selected, path: path.join(directory, 'outside.md') });
		scope.message = { id: 'user', content: forged.token, references: [forged] };
		await expect(host.resolve('thread', 'user')).rejects.toThrow('outside');
		const forgedIdentity = createComposerMention({ ...selected, id: 'file:forged' });
		scope.message = { id: 'user', content: forgedIdentity.token, references: [forgedIdentity] };
		await expect(host.resolve('thread', 'user')).rejects.toThrow('changed');
	});
	it('rejects missing files, mismatched tokens and changed project context before model dispatch', async () => {
		const { first, discover, select, host, scope } = await fixture();
		const filename = path.join(first, 'note.md');
		await writeFile(filename, 'note');
		const reference = select((await discover('note')).items[0]);
		scope.message!.content = 'No selected mention';
		await expect(host.resolve('thread', 'user')).rejects.toThrow('does not match');
		scope.message!.content = reference.token;
		await rm(filename);
		await expect(host.resolve('thread', 'user')).rejects.toThrow();
		let loads = 0;
		const changing = new ComposerContextHost(async () => ({
			...scope,
			roots: ++loads === 1 ? [first] : [],
		}));
		await expect(changing.discover(query)).rejects.toThrow('context changed');
	});
	it('loads the exact selected skill with duplicate names and revalidates configuration', async () => {
		const { skills, discover, select, host, scope } = await fixture();
		for (const name of ['first', 'second']) {
			await mkdir(path.join(skills, name));
			await writeFile(
				path.join(skills, name, 'SKILL.md'),
				`---\nname: Shared Skill\ndescription: ${name} workflow\n---\nUse ${name} workflow.`,
			);
		}
		const results = await discover('Shared', 'skills');
		expect(results.items).toHaveLength(2);
		select(results.items.find((item) => item.description === 'second workflow')!);
		const context = await host.resolve('thread', 'user');
		expect(context.instructions).toContain('Use second workflow.');
		expect(context.instructions).not.toContain('Use first workflow.');
		expect(context.instructions).toContain('subordinate guidance');
		scope.skillDirectories = [];
		await expect(host.resolve('thread', 'user')).rejects.toThrow('selected skill is unavailable');
	});
	it('keeps unbound tasks empty, caps results, and never exposes Chat local capabilities', async () => {
		const { first, discover, host, scope } = await fixture();
		await Promise.all(
			Array.from({ length: 45 }, (_, index) =>
				writeFile(path.join(first, `file-${index}.txt`), ''),
			),
		);
		expect((await discover('file')).items).toHaveLength(30);
		scope.roots = [];
		expect(await discover()).toMatchObject({
			items: [],
			warnings: [expect.stringContaining('Choose a project directory')],
		});
		scope.kind = 'chat';
		await expect(host.discover(query)).rejects.toThrow('only in Code');
		scope.kind = 'code';
		scope.allowRemote = false;
		await expect(host.discover(query, true)).rejects.toThrow('Enable remote Code tools');
	});
	it('validates the request contract instead of trusting arbitrary roots or Chat claims', () => {
		for (const invalid of [
			{ ...query, roots: ['/forged'] },
			{ ...query, conversationKind: 'chat' },
			{ ...query, query: 'x'.repeat(257) },
			{ ...query, query: 'bad\0query' },
		])
			expect(() => validateComposerDiscovery(invalid)).toThrow('Invalid');
	});
	it('projects only the active user reference and host configuration without copying credentials or media', async () => {
		const { directory, first } = await fixture();
		const state = initialState();
		state.connections[0].apiKey = 'private-provider-secret';
		state.projects = [
			{
				id: 'project',
				kind: 'code',
				name: 'Code',
				directories: [first],
				instructions: 'private project instructions',
				createdAt: 1,
			},
		];
		state.toolSettings = {
			...defaultToolSettings(),
			skillDirectories: [],
			workspaceRoot: '/unused',
		};
		state.threads = [
			{
				id: 'thread',
				kind: 'code',
				projectId: 'project',
				title: 'Task',
				model: 'model',
				connectionId: state.connections[0].id,
				createdAt: 1,
				updatedAt: 1,
				messages: [{ id: 'user', role: 'user', content: 'task', createdAt: 1 }],
				messageHistory: [{ id: 'old-user', role: 'user', content: 'old', createdAt: 1 }],
			},
		];
		const store = new StateStore(path.join(directory, 'state.json'), {
			available: () => false,
			encrypt: () => {
				throw new Error('disabled');
			},
			decrypt: () => {
				throw new Error('disabled');
			},
		});
		await store.save(state);
		const authority = new WorkspaceAuthority(store);
		const result = await authority.loadComposerState({ threadId: 'thread', messageId: 'user' });
		expect(result).toMatchObject({
			kind: 'code',
			roots: [first],
			message: { id: 'user', content: 'task', references: [] },
		});
		expect(JSON.stringify(result)).not.toContain('private-provider-secret');
		expect(JSON.stringify(result)).not.toContain('private project instructions');
		await expect(
			authority.loadComposerState({ threadId: 'thread', messageId: 'old-user' }),
		).rejects.toThrow('active path');
		await expect(
			authority.loadComposerState({ threadId: 'thread', projectId: 'wrong' }),
		).rejects.toThrow('project changed');
	});
});
