import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	approvedMarketplaceBytes,
	marketplaceRequest,
	type MarketplaceEntry,
} from '../src/lib/marketplace-client';
const bytes = new TextEncoder().encode('synthetic package bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const entry = {
	id: 'submission-1',
	packageId: 'synthetic.package',
	type: 'plugin',
	version: '1.0.0',
	status: 'approved',
	revision: 4,
	sha256,
	review: { policyVersion: 'demo-1', scannerVersion: 'scanner-1', digest: sha256 },
} as MarketplaceEntry;
function mockFetch(current = entry, artifact = bytes, header = sha256) {
	vi.stubGlobal('crypto', webcrypto);
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(new Response(artifact, { headers: { 'X-Package-SHA256': header } }))
		.mockResolvedValueOnce(Response.json({ item: current }));
	vi.stubGlobal('fetch', fetcher);
	return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
describe('marketplace installation boundary', () => {
	it('returns exact bytes only after current approval and digest checks', async () => {
		const fetcher = mockFetch();
		expect(await approvedMarketplaceBytes(entry)).toEqual(bytes);
		expect(fetcher).toHaveBeenCalledTimes(2);
		for (const [, options] of fetcher.mock.calls) {
			expect(options).toMatchObject({
				cache: 'no-store',
				credentials: 'omit',
				headers: { 'X-FreeLM-Client': 'desktop-local-demo' },
			});
		}
	});
	it('rejects changed source even when the server header agrees with the old catalog', async () => {
		const fetcher = mockFetch(entry, new TextEncoder().encode('changed bytes'));
		await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('integrity');
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('rejects a newer approval revision after a review dialog was opened', async () => {
		mockFetch({ ...entry, revision: 6 });
		await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('Approval changed');
	});
	it('rejects a missing digest header', async () => {
		mockFetch(entry, bytes, '');
		await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('integrity');
	});
	it.each(['revoked', 'rejected', 'manual_review'])(
		'rejects a cached approved card when current state is %s',
		async (status) => {
			mockFetch({ ...entry, status });
			await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('Approval changed');
		},
	);
	it.each(['policyVersion', 'scannerVersion', 'digest'])(
		'rejects changed review %s',
		async (field) => {
			mockFetch({ ...entry, review: { ...entry.review, [field]: 'changed' } });
			await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('Approval changed');
		},
	);
	it('does not return artifact bytes when the approval recheck is offline', async () => {
		const fetcher = mockFetch();
		fetcher
			.mockReset()
			.mockResolvedValueOnce(new Response(bytes, { headers: { 'X-Package-SHA256': sha256 } }))
			.mockRejectedValueOnce(Error('offline'));
		await expect(approvedMarketplaceBytes(entry)).rejects.toThrow('offline');
	});
	it('uses only an explicitly supplied credential for private reads', async () => {
		const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [] }));
		vi.stubGlobal('fetch', fetcher);
		await marketplaceRequest('submissions', 'isolated-test-token');
		expect(fetcher).toHaveBeenCalledWith(
			'http://127.0.0.1:4324/api/marketplace/submissions',
			expect.objectContaining({
				credentials: 'omit',
				headers: {
					'X-FreeLM-Client': 'desktop-local-demo',
					Authorization: 'Bearer isolated-test-token',
				},
			}),
		);
	});
});
