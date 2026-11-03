export type MarketplaceKind = 'plugin' | 'node';
export interface MarketplaceEntry {
	id: string;
	filename?: string;
	revision?: number;
	type: MarketplaceKind;
	packageId: string;
	version: string;
	name: string;
	description: string;
	publisher: string;
	sha256: string;
	bytes: number;
	status: string;
	createdAt: string;
	updatedAt: string;
	manifest: Record<string, unknown>;
	capabilities: string[];
	permissions: Record<string, unknown>;
	license: string;
	provenance: string;
	findings: { code: string; severity: string; message: string }[];
	review: { policyVersion?: string; scannerVersion?: string; digest?: string; reason?: string };
	trust: { label: string; production: boolean };
}
const origin = 'http://127.0.0.1:4324';
export async function marketplaceRequest<T>(path: string, token = '', body?: unknown): Promise<T> {
	const response = await fetch(`${origin}/api/marketplace/${path}`, {
		method: body ? 'POST' : 'GET',
		credentials: 'omit',
		cache: 'no-store',
		headers: {
			'X-FreeLM-Client': 'desktop-local-demo',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			typeof data.error === 'string'
				? data.error
				: `Marketplace request failed (${response.status}).`,
		);
	}
	return response.json() as Promise<T>;
}
export async function approvedMarketplaceBytes(entry: MarketplaceEntry): Promise<Uint8Array> {
	const response = await fetch(
		`${origin}/api/marketplace/artifacts/${encodeURIComponent(entry.id)}`,
		{
			cache: 'no-store',
			credentials: 'omit',
			headers: { 'X-FreeLM-Client': 'desktop-local-demo' },
			signal: AbortSignal.timeout(15000),
		},
	);
	if (!response.ok)
		throw new Error('This package is unavailable or no longer approved. Refresh the catalog.');
	const bytes = new Uint8Array(await response.arrayBuffer());
	const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('');
	if (digest !== entry.sha256 || response.headers.get('X-Package-SHA256') !== digest)
		throw new Error('Package integrity verification failed. Nothing was installed.');
	const { item } = await marketplaceRequest<{ item: MarketplaceEntry }>(
		`catalog/${encodeURIComponent(entry.id)}`,
	);
	if (
		item.status !== 'approved' ||
		item.revision !== entry.revision ||
		item.id !== entry.id ||
		item.packageId !== entry.packageId ||
		item.sha256 !== digest ||
		item.version !== entry.version ||
		item.type !== entry.type ||
		item.review?.policyVersion !== entry.review?.policyVersion ||
		item.review?.scannerVersion !== entry.review?.scannerVersion ||
		item.review?.digest !== entry.review?.digest
	)
		throw new Error('Approval changed. Refresh the catalog before continuing.');
	return bytes;
}
export async function marketplaceFileBase64(file: File, type: MarketplaceKind): Promise<string> {
	const limitMiB = type === 'plugin' ? 8 : 1;
	if (file.size > limitMiB * 1024 * 1024)
		throw new Error(`Choose a ${type} package no larger than ${limitMiB} MiB.`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 8192)
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(binary);
}
