# Reminders and scheduled tasks

FreeLM has a durable, local scheduler shared by Code and Bots. It lives in the Electron host process rather than a chat turn or the visible Settings page. Users can ask a local Code agent or bot to set a reminder or perform work later, and manage the resulting schedules in Settings → Scheduled tasks.

## Actions and delivery

| Action    | What happens when due                                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reminder  | FreeLM delivers the saved text to reminder history and attempts a desktop notification. A reminder created by a bot also appears as a bot message in its original conversation. No inference is required at delivery time.                                 |
| Bot task  | FreeLM queues the saved request for the destination bot. The bot receives an explicit scheduled-event context, with the original user turn and event time; FreeLM does not forge a new human message. The normal bot reply and tool loop handles the work. |
| Code task | FreeLM saves and queues the prompt in the existing Code thread, preserving its current model, project, and permissions. The local workspace must be loaded before this can be dispatched.                                                                  |

The scheduler records **delivery or admission**, not completion of model work. “Sent to bot” and “Sent to Code” mean that the destination accepted the request. A Code prompt saved to its durable queue is admitted even if immediate execution is unavailable; open that task to resume or retry its delivery. The scheduler does not resend that saved prompt. Read the bot conversation or Code thread for the result, approval requests, errors, or interrupted execution. Bot scheduled-work replies also attempt a desktop notification when they finish or fail. Clicking a scheduler notification opens schedule management.

Scheduling never grants new tool permissions or answers approvals. A bot can set reminders without permission to inspect Chat/Code history. Its future work can use only the tools and plugin grants available when that work runs. Fixed reminders continue to work without a configured or reachable model.

## Supported schedules

- One-time dates and times.
- Intervals from one minute to one year.
- Daily wall-clock times in an IANA time zone.
- Weekly wall-clock times on selected weekdays in an IANA time zone.

Daily and weekly calculation follows the selected zone, including daylight-saving changes. Nonexistent spring-forward times are skipped; repeated fall-back wall times do not create two daily executions. Model tools require explicit UTC offsets for one-time timestamps. The Settings editor uses the computer's local zone for one-time dates.

Arbitrary cron expressions, monthly/yearly calendar rules, calendar/email events, filesystem watchers, and external webhooks are not part of this first slice.

## Settings and persistence

Settings can create fixed-text reminders, edit schedules and their saved text, pause/resume, run now, and delete schedules. The recent-activity list shows delivered reminders, admitted tasks, pending/unavailable destinations, and errors. Delivered reminders can be dismissed or snoozed for ten minutes; failed or waiting deliveries can be retried. Changes save immediately rather than waiting for the general Save settings action.

Each schedule has one owning FreeLM host. Jobs and delivery history are stored under `<FreeLM data home>/scheduler/jobs.json`. Bot reminder messages and occurrence receipts are committed to the existing bot mailbox. Code prompts use the existing durable task queue. An occurrence keeps the same identity across transport retries and restart recovery, so an already-saved prompt or bot message is not inserted again. Editing a schedule does not rewrite previously admitted work, and deleting a schedule does not undo work already admitted by its destination.

Pausing a due, undelivered one-time schedule preserves its intent. Resuming it restores the same delivery identity when its destination and request are unchanged; editing the saved request creates a replacement delivery instead. Recurring schedules retain their cadence, and resume does not replay dismissed or manual deliveries. Deletion keeps the original creation receipt, so retrying an old creation request cannot silently restore a deleted schedule; a new schedule needs a new creation key.

The missed-run policy chooses whether to skip an overdue occurrence or catch up once when the host becomes available. Catch-up does not replay every missed interval. Pending-delivery overlap policies control whether another occurrence is skipped or queued; delivery admission is distinct from the destination model's full execution.

## Availability and host ownership

FreeLM must be running and the owning computer awake for on-time execution. This is not an operating-system background daemon: it does not wake a sleeping computer, launch FreeLM after shutdown, or deliver through a cloud service. Persisted schedules are checked again when FreeLM starts. Desktop notifications depend on the operating system's support and notification settings; the saved history/mailbox remains the record even if a toast cannot be shown.

Code dispatch waits while the local workspace is unavailable, including when the renderer is viewing a remote workspace. Closing FreeLM or a provider failure can interrupt admitted model work; those results belong to the existing bot/Code recovery UI rather than implying that the scheduler should rerun side effects automatically.

This first slice manages schedules locally. Remote Code runs and remote-origin bot requests cannot create or mutate schedules, and Settings does not expose local schedules while a remote workspace is selected. Bots' existing authenticated cross-host thread coordination and completion watches remain separate capabilities. Schedule ownership and execution are never silently transferred to another host.

## Tools and implementation

Code exposes `scheduler.list`, `scheduler.create`, `scheduler.update`, `scheduler.pause`, `scheduler.resume`, `scheduler.delete`, `scheduler.run_now`, `scheduler.snooze`, and `scheduler.retry`. Bots use underscore aliases such as `scheduler_create` for provider-compatible names. Tool access is limited to schedules originating in that Code thread or bot conversation. Plan mode permits only listing; reaction notifications do not expose scheduler tools.

- `electron/scheduler/service.ts`: durable job/occurrence state, admission, retry, recovery.
- `electron/scheduler/recurrence.ts`: shared time-zone-aware recurrence calculation.
- `electron/scheduler-dispatch.ts`: reminder, bot, and Code destination adapters.
- `electron/scheduler-tools.ts` and `src/lib/scheduler-tools.ts`: validated, conversation-scoped model tools.
- `electron/bot-host.ts`: durable model-free reminders and scheduled bot wakeups.
- `src/components/SchedulerSettings.tsx`: schedule management and activity history.

Workflow schedule nodes reuse the recurrence helper. Existing workflow scheduling, trigger cursors, run history, and automatic-trigger enablement remain in the workflow engine; this change does not migrate those workflows into the new Settings list.
