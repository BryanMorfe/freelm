import iroh from '@number0/iroh';
// Inspect types only: do not create an Endpoint or invoke a networking preset.
const required = ['clearIpTransports', 'portmapperConfig', 'netReportConfig'];
const missing = required.filter(name => typeof iroh.EndpointBuilder.prototype[name] !== 'function');
console.log(JSON.stringify({ version: '1.2.0', missingIsolationControls: missing, endpointStarted: false, networkTestsAllowed: missing.length === 0 }, null, 2));
process.exitCode = missing.length ? 2 : 0;
