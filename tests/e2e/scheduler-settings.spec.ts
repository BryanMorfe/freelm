import { expect, test, type Page } from '@playwright/test';
import { initialState } from '../../src/lib/state';
import type { SchedulerSnapshot } from '../../src/scheduler-types';
import { chooseOption } from './ui-controls';

test.setTimeout(180_000);
test.use({ actionTimeout: 60_000 });

// No Browser plugin is available. Exercise production Settings in an isolated
// Playwright profile with a fake desktop bridge, never the user's host or models.
async function fixture(page: Page, snapshot: SchedulerSnapshot = { jobs: [], occurrences: [] }) {
	await page.addInitScript(
		(serialized: string) => {
			const { state, snapshot } = JSON.parse(serialized);
			const changed = new Set<() => void>();
			const control: any = {
				snapshot,
				commands: [],
				saves: 0,
				providerRequests: 0,
				failNext: false,
				emit: () => changed.forEach((listener) => listener()),
			};
			(window as any).__schedulerTest = control;
			(window as any).desktop = {
				platform: 'linux',
				workspaceLoad: async () => ({ state, revision: '1' }),
				workspaceSave: async () => {
					control.saves++;
					return { revision: '2' };
				},
				storageInfo: async () => ({ secure: true, location: 'Isolated scheduler fixture' }),
				onPrepareClose: () => () => {},
				onChunk: () => () => {},
				instanceStatus: async () => ({
					host: { running: false, name: 'Local test host', instanceId: 'local', port: 4319 },
					instances: [],
				}),
				request: async () => {
					control.providerRequests++;
					throw new Error('A schedule settings test must not call a model.');
				},
				schedulerSnapshot: async () => {
					if (control.failReads) throw new Error('Schedule list temporarily unavailable.');
					return structuredClone(control.snapshot);
				},
				onSchedulerChanged: (listener: () => void) => {
					changed.add(listener);
					return () => changed.delete(listener);
				},
				schedulerCommand: async (command: any) => {
					control.commands.push(structuredClone(command));
					if (control.failNext) {
						control.failNext = false;
						throw new Error('Could not save schedule. Try again.');
					}
					const snapshot = control.snapshot;
					const job = snapshot.jobs.find((item: any) => item.id === command.id);
					const occurrence = snapshot.occurrences.find(
						(item: any) => item.id === command.occurrenceId,
					);
					const now = Date.now();
					switch (command.type) {
						case 'create':
							snapshot.jobs.push({
								...command.job,
								id: 'new-reminder',
								hostId: 'local',
								enabled: true,
								createdAt: now,
								updatedAt: now,
								nextRunAt: command.job.schedule.at || now + 3600_000,
							});
							break;
						case 'update':
							Object.assign(job, command.patch, { updatedAt: now, nextRunAt: now + 3600_000 });
							break;
						case 'pause':
							job.enabled = false;
							break;
						case 'resume':
							job.enabled = true;
							break;
						case 'delete':
							snapshot.jobs = snapshot.jobs.filter((item: any) => item.id !== command.id);
							break;
						case 'run-now':
							snapshot.occurrences.push({
								id: 'manual-reminder',
								jobId: job.id,
								hostId: 'local',
								scheduledAt: now,
								kind: 'manual',
								status: 'delivered',
								attempts: 1,
								createdAt: now,
								updatedAt: now,
								jobSnapshot: structuredClone(job),
							});
							break;
						case 'dismiss':
							occurrence.status = 'dismissed';
							break;
						case 'snooze':
							occurrence.status = 'dismissed';
							snapshot.occurrences.push({
								id: 'snoozed-reminder',
								jobId: job.id,
								hostId: 'local',
								scheduledAt: command.until,
								kind: 'manual',
								status: 'pending',
								attempts: 0,
								createdAt: now + 1,
								updatedAt: now,
								jobSnapshot: structuredClone(job),
							});
							break;
						case 'retry':
							occurrence.status = 'admitted';
							delete occurrence.error;
							delete occurrence.retryAt;
							occurrence.result = {
								status: 'admitted',
								message: 'Accepted by the existing conversation.',
							};
							break;
					}
					if (control.delayNextAcknowledgement) {
						control.delayNextAcknowledgement = false;
						const acknowledgement = structuredClone(snapshot);
						acknowledgement.occurrences.at(-1).status = 'pending';
						control.emit();
						await new Promise<void>((resolve) => {
							control.releaseAcknowledgement = resolve;
						});
						return acknowledgement;
					}
					if (control.failReadAfterCommand) control.failReads = true;
					return structuredClone(snapshot);
				},
			};
		},
		JSON.stringify({ state: initialState(), snapshot }),
	);
	await page.goto('/');
	await page
		.getByRole('button', { name: 'Personal workspace settings', exact: true })
		.click({ noWaitAfter: true });
	const settings = page.getByRole('region', { name: 'Settings', exact: true });
	const schedules = settings
		.getByRole('navigation', { name: 'Settings options' })
		.getByRole('button', { name: 'Scheduled tasks', exact: true });
	await expect(schedules).toBeVisible();
	await schedules.click({ noWaitAfter: true });
	await expect(
		settings.getByRole('heading', { name: 'Your schedules', exact: true }),
	).toBeVisible();
	return settings;
}

test('a reminder saves independently, edits its recurrence, pauses, resumes and deletes', async ({
	page,
}) => {
	const settings = await fixture(page);
	await expect(
		settings.getByRole('button', { name: 'Save settings', exact: true }),
	).not.toBeVisible();
	await settings.getByRole('button', { name: 'New reminder', exact: true }).click();
	const editor = settings.getByRole('form', { name: 'New reminder' });
	await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Review the build');
	await editor
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Read the build report.');
	await editor.getByLabel('Date and time', { exact: true }).fill('2030-05-15T09:30');
	await page.evaluate(() => {
		(window as any).__schedulerTest.failNext = true;
	});
	await editor.getByRole('button', { name: 'Create reminder' }).click();
	await expect(settings.getByRole('alert')).toContainText('Could not save schedule');
	await expect(editor.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
		'Read the build report.',
	);
	await editor.getByRole('button', { name: 'Create reminder' }).click();
	await expect(editor).not.toBeVisible();
	const job = settings.locator('[data-schedule-id="new-reminder"]');
	await expect(job.getByRole('heading', { name: 'Review the build' })).toBeVisible();
	const commands = await page.evaluate(() => (window as any).__schedulerTest.commands);
	expect(commands[0].idempotencyKey).toBe(commands[1].idempotencyKey);
	expect(commands[1].job.schedule.at).toBe(
		await page.evaluate(() => new Date('2030-05-15T09:30').getTime()),
	);
	await job.getByRole('button', { name: 'Edit', exact: true }).click();
	const edit = settings.getByRole('form', { name: 'Edit scheduled task' });
	await chooseOption(page, edit.getByRole('combobox', { name: 'Repeat', exact: true }), 'weekly');
	await edit.getByLabel('Time', { exact: true }).fill('08:15');
	await edit.getByLabel('Time zone', { exact: true }).fill('Europe/London');
	await edit.getByRole('button', { name: 'Monday', exact: true }).click();
	await edit.getByRole('button', { name: 'Save schedule', exact: true }).click();
	await expect(job).toContainText('08:15 · Europe/London');
	await job.getByRole('button', { name: 'Pause', exact: true }).click();
	await expect(job).toContainText('Paused');
	await job.getByRole('button', { name: 'Resume', exact: true }).click();
	await expect(job.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
	await job.getByRole('button', { name: 'Delete Review the build' }).click();
	await job.getByRole('button', { name: 'Delete schedule', exact: true }).click();
	await expect(job).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).__schedulerTest.providerRequests)).toBe(0);
});

test('reminders can be delivered now, snoozed without moving recurrence, and dismissed', async ({
	page,
}) => {
	const job = {
		id: 'reminder',
		hostId: 'local',
		title: 'Stretch',
		target: { kind: 'reminder' as const, message: 'Take a short break.' },
		schedule: { kind: 'interval' as const, intervalMinutes: 60, missed: 'once' as const },
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		nextRunAt: Date.now() + 3600_000,
	};
	const settings = await fixture(page, { jobs: [job], occurrences: [] });
	await settings.getByRole('button', { name: 'Run now', exact: true }).click();
	const delivered = settings.locator('[data-occurrence-id="manual-reminder"]');
	await expect(delivered).toContainText('Delivered');
	await delivered.getByRole('button', { name: 'Snooze 10 minutes' }).click();
	await expect(delivered).toContainText('Dismissed');
	const pending = settings.locator('[data-occurrence-id="snoozed-reminder"]');
	await expect(pending).toContainText('Scheduled');
	expect(
		await page.evaluate(() => (window as any).__schedulerTest.snapshot.jobs[0].schedule),
	).toEqual(job.schedule);
	await page.evaluate(() => {
		const control = (window as any).__schedulerTest;
		control.snapshot.occurrences.find((item: any) => item.id === 'snoozed-reminder').status =
			'delivered';
		control.emit();
	});
	await pending.getByRole('button', { name: 'Dismiss', exact: true }).click();
	await expect(pending).toContainText('Dismissed');
	expect(
		await page.evaluate(
			() =>
				(window as any).__schedulerTest.commands.find((item: any) => item.type === 'snooze')
					.occurrenceId,
		),
	).toBe('manual-reminder');
});

test('Code and bot destinations are preserved, failures remain visible and retry means admission', async ({
	page,
}) => {
	const jobs: SchedulerSnapshot['jobs'] = [
		{
			id: 'code',
			hostId: 'local',
			title: 'Check the build',
			target: { kind: 'code', threadId: 'existing-code-thread', prompt: 'Read the build log.' },
			schedule: { kind: 'daily', time: '09:00', timezone: 'America/New_York' },
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
		},
		{
			id: 'bot',
			hostId: 'local',
			title: 'Morning brief',
			target: {
				kind: 'bot',
				botId: 'nova',
				conversationId: 'direct-nova',
				userMessageId: 'authorized-message',
				prompt: 'Summarize my tasks.',
			},
			schedule: { kind: 'interval', intervalMinutes: 120 },
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const settings = await fixture(page, {
		jobs,
		occurrences: jobs.map((job, index) => ({
			id: `${job.id}-error`,
			jobId: job.id,
			hostId: 'local',
			scheduledAt: Date.now(),
			kind: 'scheduled',
			status: index ? 'failed' : 'waiting',
			error: index ? 'Model unavailable.' : 'Open the local workspace to continue.',
			attempts: 1,
			createdAt: 2,
			updatedAt: 2,
			jobSnapshot: job,
		})),
	});
	await expect(settings).toContainText('Open the local workspace to continue.');
	await expect(settings).toContainText('Model unavailable.');
	await page.screenshot({ path: '/tmp/freelm-scheduler-settings-dark.png' });
	for (const job of jobs) {
		await settings
			.locator(`[data-schedule-id="${job.id}"]`)
			.getByRole('button', { name: 'Edit', exact: true })
			.click();
		const editor = settings.getByRole('form', { name: 'Edit scheduled task' });
		await editor
			.getByRole('textbox', { name: 'Instructions', exact: true })
			.fill('Only notify me if something needs my attention.');
		await editor.getByRole('button', { name: 'Save schedule', exact: true }).click();
		await expect(editor).not.toBeVisible();
		const updated = await page.evaluate(
			(id) => (window as any).__schedulerTest.snapshot.jobs.find((item: any) => item.id === id),
			job.id,
		);
		expect(updated.target).toEqual({
			...job.target,
			prompt: 'Only notify me if something needs my attention.',
		});
		const update = await page.evaluate(
			(id) =>
				(window as any).__schedulerTest.commands.findLast(
					(command: any) => command.type === 'update' && command.id === id,
				),
			job.id,
		);
		expect(update.patch).not.toHaveProperty('schedule');
		await settings
			.locator(`[data-occurrence-id="${job.id}-error"]`)
			.getByRole('button', { name: 'Retry', exact: true })
			.click();
		await expect(settings.locator(`[data-occurrence-id="${job.id}-error"]`)).toContainText(
			job.id === 'bot' ? 'Sent to bot' : 'Sent to Code',
		);
	}
	await expect(settings).toContainText('not that its work has finished');
	expect(await page.evaluate(() => (window as any).__schedulerTest.providerRequests)).toBe(0);
});

test('schedule controls remain readable and within the content column at a narrow width', async ({
	page,
}) => {
	await page.setViewportSize({ width: 720, height: 940 });
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const settings = await fixture(page);
	await settings.getByRole('button', { name: 'New reminder', exact: true }).click();
	const editor = settings.getByRole('form', { name: 'New reminder' });
	await chooseOption(page, editor.getByRole('combobox', { name: 'Repeat', exact: true }), 'weekly');
	const measurements = await settings.locator('.scheduler-settings').evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const controls = [...element.querySelectorAll('button, input, textarea, label, h3, h4')].filter(
			(node) => (node as HTMLElement).offsetWidth > 0,
		);
		return controls.map((node) => ({
			text: node.textContent,
			size: parseFloat(getComputedStyle(node).fontSize),
			inside:
				node.getBoundingClientRect().right <= bounds.right + 1 &&
				node.getBoundingClientRect().left >= bounds.left - 1,
		}));
	});
	expect(
		measurements.every((item) => item.size >= 13 && item.inside),
		JSON.stringify(measurements),
	).toBe(true);
	expect(errors).toEqual([]);
	await page.screenshot({ path: '/tmp/freelm-scheduler-settings-narrow.png' });
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'light';
	});
	await page.screenshot({ path: '/tmp/freelm-scheduler-settings-light.png' });
});

test('a late command acknowledgement cannot overwrite a newer delivery event', async ({ page }) => {
	const job: SchedulerSnapshot['jobs'][number] = {
		id: 'race-reminder',
		hostId: 'local',
		title: 'Review the report',
		target: { kind: 'reminder', message: 'The report is ready.' },
		schedule: { kind: 'interval', intervalMinutes: 60 },
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
	const settings = await fixture(page, { jobs: [job], occurrences: [] });
	await page.evaluate(() => {
		(window as any).__schedulerTest.delayNextAcknowledgement = true;
	});
	await settings.getByRole('button', { name: 'Run now', exact: true }).click({ noWaitAfter: true });
	const occurrence = settings.locator('[data-occurrence-id="manual-reminder"]');
	await expect(occurrence).toContainText('Delivered');
	await page.evaluate(() => {
		(window as any).__schedulerTest.releaseAcknowledgement();
	});
	await expect(settings.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
	await expect(occurrence).toContainText('Delivered');
	await page.evaluate(() => {
		(window as any).__schedulerTest.failReadAfterCommand = true;
	});
	await settings.getByRole('button', { name: 'Pause', exact: true }).click({ noWaitAfter: true });
	await expect(settings.getByRole('alert')).toContainText(
		'The change was saved, but the list could not refresh',
	);
	expect(await page.evaluate(() => (window as any).__schedulerTest.snapshot.jobs[0].enabled)).toBe(
		false,
	);
});
