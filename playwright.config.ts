import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 60_000,
	expect: { timeout: 5_000 },
	fullyParallel: true,
	workers: 2,
	reporter: 'list',
	outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || '/tmp/freelm-e2e-results',
	use: {
		...devices['Desktop Chrome'],
		baseURL: 'http://127.0.0.1:5173',
		viewport: { width: 1440, height: 940 },
		channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	webServer: {
		command: 'npm run dev -- --port 5173',
		url: 'http://127.0.0.1:5173',
		reuseExistingServer: true,
		timeout: 30_000,
	},
});
