import { useEffect, useState } from 'react';
import type { WorkflowBindingSummary } from '../workflow-types';

/** Navigation reads only labels and IDs, never research history or graph snapshots. */
export function useProjectWorkflows(enabled: boolean) {
	const [bindings, setBindings] = useState<WorkflowBindingSummary[]>([]);
	useEffect(() => {
		if (!enabled) { setBindings([]); return; }
		const read = window.desktop?.workflowBindings;
		if (!read) return;
		let disposed = false, reading = false, again = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			if (reading) { again = true; return; }
			reading = true;
			try {
				do {
					again = false;
					const next = await read();
					if (!disposed) setBindings((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
				} while (again && !disposed);
			} catch {
				// The workflow surface reports initialization/connection errors. Other navigation stays usable.
			} finally { reading = false; }
		};
		void refresh();
		const unsubscribe = window.desktop?.onWorkflowsChanged?.(() => {
			if (timer) return;
			timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
		});
		return () => { disposed = true; clearTimeout(timer); unsubscribe?.(); };
	}, [enabled]);
	return bindings;
}
