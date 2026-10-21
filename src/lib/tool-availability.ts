/** Names only: availability errors must not echo tool arguments, schemas, or credentials. */
export interface ToolAvailabilityEntry {
	name: string;
	apiName: string;
	source: 'builtin' | 'mcp' | 'skill' | 'plugin';
}

const diagnosticName = (name: string) => (name.length > 160 ? `${name.slice(0, 160)}…` : name);

/** Recovery is advice, never alias normalization or permission to execute an unoffered tool. */
export function unavailableToolMessage(
	requestedName: string,
	offered: readonly ToolAvailabilityEntry[],
	availableNextRequest: readonly ToolAvailabilityEntry[] = [],
): string {
	const exact = offered.find(
		(tool) => tool.name === requestedName || tool.apiName === requestedName,
	);
	// Models sometimes add their own namespace. Suggest an unambiguous offered name,
	// but require a new correctly named call instead of silently dispatching it.
	const qualified = offered.filter(
		(tool) => requestedName.endsWith(`.${tool.apiName}`) || requestedName.endsWith(`.${tool.name}`),
	);
	const suggested = exact ?? (qualified.length === 1 ? qualified[0] : undefined);
	const next = availableNextRequest.find(
		(tool) => tool.name === requestedName || tool.apiName === requestedName,
	);
	const discovery = offered.find(
		(tool) => tool.source === 'builtin' && tool.name === 'tool_search',
	);
	let recovery: string;
	if (suggested && suggested.apiName !== requestedName) {
		recovery = `Use the exact offered API name ${JSON.stringify(suggested.apiName)} in a new call. Names are not automatically normalized.`;
	} else if (next) {
		recovery = `This tool was discovered after the current request. It becomes callable in the next model request as ${JSON.stringify(next.apiName)}; it cannot run in this call batch.`;
	} else if (discovery) {
		recovery = `Use ${JSON.stringify(discovery.apiName)} to discover additional tools. Discovered tools become callable in the next model request.`;
	} else {
		recovery =
			'No tool-discovery function is offered in this request. Use an offered tool with the needed capability, or explain that the capability is unavailable.';
	}
	const sample = offered.slice(0, 12).map((tool) => diagnosticName(tool.apiName));
	const diagnostics = {
		requestedName: diagnosticName(requestedName),
		canonicalName: suggested || next ? diagnosticName((suggested ?? next)!.name) : null,
		offeredCount: offered.length,
		offeredNames: sample,
		omittedNames: Math.max(0, offered.length - sample.length),
	};
	return `This tool is unavailable in the current request. No action was run. ${recovery}\nTool availability: ${JSON.stringify(diagnostics)}`;
}
