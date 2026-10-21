import path from 'node:path';

export interface StoragePaths {
	home: string;
	cache: string;
	legacy?: string;
	config: string;
	workspace: string;
	instances: string;
	skills: string;
	recovery: string;
}

export function resolveStoragePaths(options: {
	platform: string;
	home: string;
	userData: string;
	packaged: boolean;
	env: NodeJS.ProcessEnv;
}): StoragePaths {
	const { platform, home, userData, packaged, env } = options;
	const testRoot = !packaged && env.FREELM_USER_DATA;
	const override = testRoot || env.FREELM_HOME;
	let root = path.join(home, '.freelm');
	if (override) {
		root = override.startsWith('~/') ? path.join(home, override.slice(2)) : override;
		if (!path.isAbsolute(root))
			throw new Error('FREELM_HOME must be an absolute path or start with ~/.');
		root = path.resolve(root);
	}
	const cacheRoot =
		platform === 'darwin'
			? path.join(home, 'Library', 'Caches')
			: env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)
				? env.XDG_CACHE_HOME
				: path.join(home, '.cache');
	return {
		home: root,
		// Explicit homes also isolate Chromium so parallel test/development profiles do not collide.
		cache: override ? path.join(root, '.cache') : path.join(cacheRoot, 'FreeLM'),
		legacy: override ? undefined : userData,
		config: path.join(root, 'config.json'),
		workspace: path.join(root, 'workspace.json'),
		instances: path.join(root, 'instances.json'),
		skills: path.join(root, 'skills'),
		recovery: path.join(root, 'recovery'),
	};
}
