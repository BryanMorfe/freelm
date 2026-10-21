const activities = new Set<Promise<void>>();

/** Register work whose final state must be applied before saving or changing workspaces. */
export function beginActivity(): () => void {
	let complete!: () => void;
	const activity = new Promise<void>((resolve) => {
		complete = resolve;
	});
	activities.add(activity);
	return () => {
		activities.delete(activity);
		complete();
	};
}

export async function settleActivities(): Promise<void> {
	while (activities.size) await Promise.all([...activities]);
}
