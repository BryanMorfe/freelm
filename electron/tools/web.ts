import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { DomHandler, Parser, parseDocument } from 'htmlparser2';
import type {
	ToolHostRequest,
	ToolResult,
	ToolSettings,
	WebServiceInfo,
} from '../../src/agent-types';
import { searxngSearchUrl } from '../../src/lib/web-tools';
import type { ResearchImage, ResearchSource } from '../../src/research-types';
import { textResult } from './common';
import { PdfProcessor } from './pdf';
import { decodeWebImage } from './web-image';

type WebConfig = NonNullable<ToolSettings['webBrowsing']>;
interface Address {
	address: string;
	family: number;
}
interface RuntimeOptions {
	resolve?: (hostname: string) => Promise<Address[]>;
	request?: (
		url: URL,
		options: RequestOptions,
		callback: (response: IncomingMessage) => void,
	) => ClientRequest;
	timeoutMs?: number;
}
interface Link {
	id: number;
	title: string;
	url: string;
}
interface Source {
	ref_id: string;
	title: string;
	url: string;
	snippet?: string;
	published_date?: string;
	engine?: string;
	engines?: string[];
	img_src?: string;
	thumbnail_src?: string;
	accessed_at?: number;
	width?: number;
	height?: number;
}
interface Page extends Source {
	lines: string[];
	links: Link[];
	truncated: boolean;
	pdf?: boolean;
	total_pages?: number;
}
interface PdfPage {
	lines: string[];
	links: Link[];
}
interface PdfCache {
	bytes: Uint8Array;
	pages: PdfPage[];
	title: string;
	size: number;
}
interface Run {
	owner: string;
	configUrl: string;
	prefix: string;
	counter: number;
	sources: Map<string, Source>;
	pages: Map<string, Page>;
	pdfs: Map<string, PdfCache>;
	controllers: Set<AbortController>;
	viewedImages: Set<string>;
	lastUsed: number;
	closed: boolean;
}
const MAX_RESPONSE_BYTES = 48 * 1024;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PDF_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_WEB_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 128;
const MAX_PAGE_CHARS = 120_000;
const RUN_TTL = 30 * 60_000;
const operationNames = [
	'search_query',
	'image_query',
	'open',
	'click',
	'find',
	'screenshot',
] as const;
type Operation = (typeof operationNames)[number];

function cancelled(): Error {
	return new Error('Web browsing was cancelled.');
}
function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? cancelled();
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	checkAbort(signal);
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? cancelled());
		signal.addEventListener('abort', abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}
async function retryBackoff(signal: AbortSignal): Promise<void> {
	checkAbort(signal);
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			reject(signal.reason ?? cancelled());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, 250);
		signal.addEventListener('abort', abort, { once: true });
	});
}
class WebHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Conservatively allow global unicast addresses; mapped IPv4 uses the same IPv4 policy. */
export function publicWebAddress(address: string): boolean {
	const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
	if (isIP(ip) === 4) {
		const [a, b, c] = ip.split('.').map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(ip) !== 6 || ip.includes('%')) return false;
	let normalized = ip;
	if (ip.includes('.')) {
		const lastColon = ip.lastIndexOf(':');
		const octets = ip
			.slice(lastColon + 1)
			.split('.')
			.map(Number);
		normalized = `${ip.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const [left, right = ''] = normalized.split('::');
	const start = left ? left.split(':') : [];
	const end = right ? right.split(':') : [];
	const parts = normalized.includes('::')
		? [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
		: start;
	if (parts.length !== 8) return false;
	const words = parts.map((part) => parseInt(part, 16));
	if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
		return publicWebAddress(
			`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`,
		);
	if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
	// Documentation, Teredo, 6to4 and special-purpose allocations are not ordinary public pages.
	return !(
		(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) ||
		words[0] === 0x2002 ||
		(words[0] === 0x3fff && words[1] < 0x1000)
	);
}

export function publicPageUrl(input: string): URL {
	if (!input || input.length > 2048)
		throw new Error('A public HTTP or HTTPS URL of at most 2048 characters is required.');
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error('Use a source reference or a complete public HTTP or HTTPS URL.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
		throw new Error('Only public HTTP or HTTPS pages without embedded credentials can be opened.');
	const hostname = url.hostname
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '')
		.toLowerCase();
	if (
		!hostname ||
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		(isIP(hostname) && !publicWebAddress(hostname))
	)
		throw new Error('Local and private network pages cannot be opened by web browsing.');
	url.hash = '';
	if (url.href.length > 2048)
		throw new Error('The normalized web page URL exceeds 2048 characters.');
	return url;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error('Unsupported web browsing argument.');
}
function required(value: unknown, label: string, limit: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > limit)
		throw new Error(`${label} must be nonempty text of at most ${limit} characters.`);
	return value.trim();
}
function validateArguments(args: Record<string, unknown>): void {
	keys(args, [...operationNames, 'response_length']);
	if (
		args.response_length !== undefined &&
		!['short', 'medium', 'long'].includes(String(args.response_length))
	)
		throw new Error('response_length must be short, medium, or long.');
	let total = 0;
	for (const name of operationNames) {
		const operations = args[name];
		if (operations === undefined) continue;
		if (!Array.isArray(operations) || !operations.length || operations.length > 4)
			throw new Error(`Provide one to four ${name} entries.`);
		total += operations.length;
		for (const item of operations) {
			if (!record(item)) throw new Error(`Each ${name} entry must be an object.`);
			if (name === 'search_query' || name === 'image_query') {
				keys(item, [
					'q',
					'domains',
					'blocked_domains',
					'engines',
					'page',
					'limit',
					'language',
					'time_range',
					'safesearch',
					'timeout_limit',
					'start_date',
					'end_date',
					'recency',
					...(name === 'image_query' ? [] : ['categories']),
				]);
				required(item.q, 'Search query', 1000);
				if (
					item.domains !== undefined &&
					(!Array.isArray(item.domains) ||
						!item.domains.length ||
						item.domains.length > 5 ||
						!item.domains.every((domain) => typeof domain === 'string' && validDomain(domain)))
				)
					throw new Error('domains must contain one to five domain names, such as example.com.');
				if (
					item.blocked_domains !== undefined &&
					(!Array.isArray(item.blocked_domains) ||
						!item.blocked_domains.length ||
						item.blocked_domains.length > 20 ||
						!item.blocked_domains.every(
							(domain) => typeof domain === 'string' && validDomain(domain),
						))
				)
					throw new Error('blocked_domains must contain one to twenty valid domain names.');
				for (const key of ['engines', 'categories'])
					if (
						item[key] !== undefined &&
						(!Array.isArray(item[key]) ||
							!item[key].length ||
							item[key].length > 8 ||
							!item[key].every(
								(value) =>
									typeof value === 'string' &&
									value.trim() &&
									value.length <= 100 &&
									!/[\r\n,]/.test(value),
							))
					)
						throw new Error(`${key} must contain one to eight exact SearXNG names.`);
				for (const [key, min, max] of [
					['page', 1, 10],
					['limit', 1, 20],
					['safesearch', 0, 2],
				] as const)
					if (
						item[key] !== undefined &&
						(!Number.isInteger(item[key]) || Number(item[key]) < min || Number(item[key]) > max)
					)
						throw new Error(`${key} must be a whole number from ${min} to ${max}.`);
				if (
					item.language !== undefined &&
					(typeof item.language !== 'string' ||
						!/^[a-zA-Z][a-zA-Z0-9_-]{0,34}$/.test(item.language))
				)
					throw new Error('language must be a valid language or locale code.');
				if (
					item.time_range !== undefined &&
					!['day', 'week', 'month', 'year'].includes(String(item.time_range))
				)
					throw new Error('time_range must be day, week, month, or year.');
				if (
					item.timeout_limit !== undefined &&
					(typeof item.timeout_limit !== 'number' ||
						!Number.isFinite(item.timeout_limit) ||
						item.timeout_limit <= 0 ||
						item.timeout_limit > 12)
				)
					throw new Error('timeout_limit must be a positive finite number of seconds, at most 12.');
				if (
					item.recency !== undefined &&
					(typeof item.recency !== 'number' ||
						!Number.isFinite(item.recency) ||
						item.recency <= 0 ||
						item.recency > 3650)
				)
					throw new Error('recency must be a positive number of days, at most 3650.');
				for (const key of ['start_date', 'end_date'])
					if (item[key] !== undefined) strictDate(item[key], key);
				if (item.start_date && item.end_date && String(item.start_date) > String(item.end_date))
					throw new Error('start_date cannot be after end_date.');
			} else {
				keys(
					item,
					name === 'open'
						? ['ref_id', 'lineno', 'pageno']
						: name === 'screenshot'
							? ['ref_id', 'pageno']
							: name === 'click'
								? ['ref_id', 'id']
								: ['ref_id', 'pattern'],
				);
				required(item.ref_id, 'Source reference', 2048);
				if (name === 'find') required(item.pattern, 'Find pattern', 500);
				if (
					(name === 'screenshot' || item.pageno !== undefined) &&
					(!Number.isSafeInteger(item.pageno) || Number(item.pageno) < 0)
				)
					throw new Error('pageno must be a zero-based nonnegative whole number.');
				if (
					(name === 'click' || item.lineno !== undefined) &&
					(!Number.isSafeInteger(item[name === 'click' ? 'id' : 'lineno']) ||
						Number(item[name === 'click' ? 'id' : 'lineno']) < 1)
				)
					throw new Error('Line and link numbers must be positive whole numbers.');
			}
		}
	}
	if (!total || total > 8)
		throw new Error('Provide at least one web operation, and at most eight operations per call.');
}
function strictDate(value: unknown, key: string): number {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
		throw new Error(`${key} must be a date in YYYY-MM-DD form.`);
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
		throw new Error(`${key} must be a real calendar date.`);
	return timestamp;
}
function boundedMetadata(value: unknown, depth = 0): unknown {
	if (depth > 4) return '[metadata truncated]';
	if (typeof value === 'string') return value.slice(0, 500);
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'boolean' || value === null) return value;
	if (Array.isArray(value))
		return value.slice(0, 20).map((item) => boundedMetadata(item, depth + 1));
	if (record(value))
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, 20)
				.map(([key, item]) => [key.slice(0, 100), boundedMetadata(item, depth + 1)]),
		);
	return null;
}
function providerTimestamp(value: string | undefined): number {
	if (!value || value.length > 100) return NaN;
	const calendar = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(value)?.[1];
	if (calendar) {
		try {
			strictDate(calendar, 'published_date');
		} catch {
			return NaN;
		}
	}
	return Date.parse(value);
}
function validDomain(domain: string): boolean {
	if (domain.length > 253 || /[\s/:?#@*]/.test(domain)) return false;
	try {
		const host = new URL(`https://${domain}`).hostname;
		return (
			!!host &&
			host
				.split('.')
				.every(
					(part) =>
						part.length > 0 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part),
				)
		);
	} catch {
		return false;
	}
}

// htmlparser2 owns entity decoding, malformed-markup recovery and the tree structure.
type HtmlNode = {
	type: string;
	name?: string;
	data?: string;
	attribs?: Record<string, string>;
	children?: HtmlNode[];
};
const excludedTags = new Set([
	'script',
	'style',
	'noscript',
	'template',
	'svg',
	'canvas',
	'iframe',
	'form',
	'nav',
	'footer',
]);
const blocks = new Set([
	'p',
	'div',
	'section',
	'article',
	'main',
	'header',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'li',
	'ul',
	'ol',
	'blockquote',
	'pre',
	'tr',
	'table',
	'hr',
	'br',
]);
function nodeText(node: HtmlNode): string {
	const stack = [node];
	let result = '';
	let visited = 0;
	while (stack.length && visited++ < 40_000 && result.length < MAX_PAGE_CHARS) {
		const current = stack.pop()!;
		if (
			excludedTags.has(current.name ?? '') ||
			current.attribs?.hidden !== undefined ||
			current.attribs?.['aria-hidden'] === 'true'
		)
			continue;
		if (current.type === 'text') result += current.data ?? '';
		else
			for (let index = (current.children?.length ?? 0) - 1; index >= 0; index--)
				stack.push(current.children![index]);
	}
	return result.slice(0, MAX_PAGE_CHARS);
}
function findElement(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | undefined {
	const stack = [node];
	let visited = 0;
	while (stack.length && visited++ < 40_000) {
		const current = stack.pop()!;
		if (predicate(current)) return current;
		for (let index = (current.children?.length ?? 0) - 1; index >= 0; index--)
			stack.push(current.children![index]);
	}
	return undefined;
}

class BoundedDomHandler extends DomHandler {
	private depth = 0;
	private nodes = 0;
	override onopentag(name: string, attributes: Record<string, string>): void {
		if (++this.depth > 256 || ++this.nodes > 40_000)
			throw new Error('This page has too much nested or complex HTML to read safely.');
		super.onopentag(name, attributes);
	}
	override onclosetag(): void {
		this.depth = Math.max(0, this.depth - 1);
		super.onclosetag();
	}
	override ontext(data: string): void {
		if (++this.nodes > 40_000) throw new Error('This page has too much HTML to read safely.');
		super.ontext(data);
	}
}
async function parseWebDocument(text: string, signal: AbortSignal): Promise<HtmlNode> {
	const handler = new BoundedDomHandler();
	const parser = new Parser(handler);
	for (let offset = 0; offset < text.length; offset += 32_768) {
		checkAbort(signal);
		parser.write(text.slice(offset, offset + 32_768));
		if (offset + 32_768 < text.length) await new Promise<void>((resolve) => setImmediate(resolve));
	}
	parser.end();
	checkAbort(signal);
	return handler.root as unknown as HtmlNode;
}
function plainLines(text: string): string[] {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
		.split('\n')
		.flatMap((line) => {
			const value = line.replace(/[\t\u00a0 ]+/g, ' ').trim();
			if (!value) return [];
			return value.match(/.{1,160}(?:\s|$)|.{1,160}/gu)?.map((part) => part.trim()) ?? [];
		});
}

export function extractWebPage(
	text: string,
	url: URL,
	html: boolean,
	parsedDocument?: HtmlNode,
): Omit<Page, 'ref_id'> {
	if (!html)
		return {
			title: url.hostname,
			url: url.href,
			lines: plainLines(text.slice(0, MAX_PAGE_CHARS)),
			links: [],
			truncated: text.length > MAX_PAGE_CHARS,
		};
	const document = parsedDocument ?? (parseDocument(text) as unknown as HtmlNode);
	const titleNode = findElement(document, (node) => node.name === 'title');
	const title =
		(titleNode ? nodeText(titleNode).replace(/\s+/g, ' ').trim().slice(0, 300) : '') ||
		url.hostname;
	const body =
		findElement(
			document,
			(node) => node.name === 'main' || node.name === 'article' || node.attribs?.role === 'main',
		) ??
		findElement(document, (node) => node.name === 'body') ??
		document;
	let base = url;
	const baseHref = findElement(document, (node) => node.name === 'base' && !!node.attribs?.href)
		?.attribs?.href;
	if (baseHref) {
		try {
			base = publicPageUrl(new URL(baseHref, url).href);
		} catch {
			/* Ignore unusable base URLs. */
		}
	}
	const links: Link[] = [];
	let output = '';
	let truncated = false;
	const stack: { node: HtmlNode; depth: number; closing: boolean }[] = [
		{ node: body, depth: 0, closing: false },
	];
	let visited = 0;
	while (stack.length) {
		const { node, depth, closing } = stack.pop()!;
		if (++visited > 80_000 || output.length >= MAX_PAGE_CHARS) {
			truncated = true;
			break;
		}
		if (depth > 256) {
			truncated = true;
			continue;
		}
		const tag = node.name ?? '';
		if (
			excludedTags.has(tag) ||
			node.attribs?.hidden !== undefined ||
			node.attribs?.['aria-hidden'] === 'true'
		)
			continue;
		if (node.type === 'text') {
			output += node.data ?? '';
			continue;
		}
		if (!closing) {
			if (blocks.has(tag)) output += '\n';
			if (tag === 'img' && node.attribs?.alt) output += node.attribs.alt;
			stack.push({ node, depth, closing: true });
			for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
				stack.push({ node: node.children![index], depth: depth + 1, closing: false });
			continue;
		}
		if (tag === 'a' && node.attribs?.href && links.length < 100) {
			try {
				const target = publicPageUrl(new URL(node.attribs.href, base).href);
				const title = nodeText(node).replace(/\s+/g, ' ').trim().slice(0, 300) || target.hostname;
				const existing = links.find((link) => link.url === target.href);
				const link = existing ?? { id: links.length + 1, title, url: target.href };
				if (!existing) links.push(link);
				output += ` [${link.id}]`;
			} catch {
				/* Non-web and private literal links are not browsing targets. */
			}
		}
		if (blocks.has(tag) || tag === 'td' || tag === 'th')
			output += tag === 'td' || tag === 'th' ? ' ' : '\n';
	}
	return {
		title,
		url: url.href,
		lines: plainLines(output.slice(0, MAX_PAGE_CHARS)),
		links,
		truncated,
	};
}

interface FetchResult {
	url: URL;
	text: string;
	contentType: string;
	bytes?: Buffer;
}
export class WebRuntime {
	private runs = new Map<string, Run>();
	private serviceConfigs = new Map<string, { info: WebServiceInfo; expires: number }>();
	private discoveryControllers = new Set<AbortController>();
	private pdf = new PdfProcessor();
	private pdfCacheBytes = 0;
	private closed = false;
	private readonly resolve: NonNullable<RuntimeOptions['resolve']>;
	private readonly request: NonNullable<RuntimeOptions['request']>;
	private readonly timeoutMs: number;
	constructor(options: RuntimeOptions = {}) {
		this.resolve =
			options.resolve ??
			(async (hostname) => await lookup(hostname, { all: true, verbatim: true }));
		this.request =
			options.request ??
			((url, options, callback) =>
				(url.protocol === 'https:' ? https : http).request(url, options, callback));
		this.timeoutMs = options.timeoutMs ?? 45_000;
	}

	/** Only explicitly configured service endpoints may use local network addresses. */
	async discover(input: string, signal: AbortSignal): Promise<WebServiceInfo> {
		if (this.closed) throw new Error('The web browsing runtime has closed.');
		const endpoint = searxngSearchUrl(input);
		const controller = new AbortController();
		const abort = () => controller.abort(signal.reason ?? cancelled());
		checkAbort(signal);
		signal.addEventListener('abort', abort, { once: true });
		this.discoveryControllers.add(controller);
		const timer = setTimeout(
			() => controller.abort(new Error('SearXNG discovery timed out.')),
			Math.min(this.timeoutMs, 20_000),
		);
		try {
			const info = await this.serviceInfo(endpoint, controller.signal, true);
			const healthUrl = this.serviceEndpoint(endpoint, 'healthz');
			try {
				const health = await this.fetch(healthUrl, true, controller.signal);
				if (health.text.trim() !== 'OK' || !/^text\/plain(?:[;\s]|$)/i.test(health.contentType))
					throw new Error(
						'The health endpoint did not return the expected plain-text OK response.',
					);
				info.health = 'ok';
			} catch (error) {
				checkAbort(controller.signal);
				info.health = 'unavailable';
				info.notices.push(
					`Health endpoint unavailable: ${error instanceof Error ? error.message.slice(0, 300) : 'request failed'}. This does not establish upstream engine health.`,
				);
			}
			info.notices.push(
				'Service discovery and health do not verify that upstream search engines are working. Inspect unresponsive_engines on each search.',
			);
			return info;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			this.discoveryControllers.delete(controller);
		}
	}
	private serviceEndpoint(endpoint: URL, route: string): URL {
		const url = new URL(endpoint);
		url.pathname = url.pathname.replace(/\/search$/, `/${route}`);
		url.search = '';
		return url;
	}
	private async serviceInfo(
		endpoint: URL,
		signal: AbortSignal,
		refresh = false,
	): Promise<WebServiceInfo> {
		const cached = this.serviceConfigs.get(endpoint.href);
		if (!refresh && cached && cached.expires > Date.now()) return structuredClone(cached.info);
		const response = await this.fetch(this.serviceEndpoint(endpoint, 'config'), true, signal);
		const data = this.serviceJson(response);
		if (!record(data) || !Array.isArray(data.engines) || !Array.isArray(data.categories))
			throw new Error(
				'SearXNG /config did not advertise engines and categories. Check the configured service URL.',
			);
		const info: WebServiceInfo = {
			serviceUrl: endpoint.href.replace(/\/search$/, ''),
			...(typeof data.version === 'string' ? { version: data.version.slice(0, 100) } : {}),
			categories: data.categories
				.filter(
					(category): category is string => typeof category === 'string' && category.length <= 100,
				)
				.slice(0, 100),
			engines: data.engines
				.filter(record)
				.filter((engine) => typeof engine.name === 'string' && engine.name.length <= 100)
				.slice(0, 200)
				.map((engine) => ({
					name: String(engine.name),
					enabled: engine.enabled === true,
					categories: Array.isArray(engine.categories)
						? engine.categories
								.filter(
									(category): category is string =>
										typeof category === 'string' && category.length <= 100,
								)
								.slice(0, 20)
						: [],
					paging: engine.paging === true,
					timeRangeSupport: engine.time_range_support === true,
					safeSearch: engine.safesearch === true,
				})),
			health: 'unavailable',
			notices: [],
		};
		if (data.engines.length > 200 || data.categories.length > 100)
			info.notices.push('Service capability metadata was truncated to FreeLM limits.');
		checkAbort(signal);
		if (this.closed) throw new Error('The web browsing runtime has closed.');
		this.serviceConfigs.set(endpoint.href, {
			info: structuredClone(info),
			expires: Date.now() + 5 * 60_000,
		});
		if (this.serviceConfigs.size > 16)
			this.serviceConfigs.delete(this.serviceConfigs.keys().next().value!);
		return info;
	}
	private serviceJson(response: FetchResult): unknown {
		if (!/^(?:application\/(?:json|[^;\s]+\+json))(?:[;\s]|$)/i.test(response.contentType))
			throw new Error(
				'SearXNG did not return JSON. Enable json in search.formats in its settings.yml (for example [html, json]) and check the service URL.',
			);
		try {
			return JSON.parse(response.text);
		} catch {
			throw new Error(
				'SearXNG returned invalid JSON. Check the service response and enable json in search.formats in settings.yml.',
			);
		}
	}

	async execute(
		request: ToolHostRequest,
		config: WebConfig,
		signal: AbortSignal,
	): Promise<ToolResult> {
		let controller: AbortController | undefined;
		let run: Run | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		try {
			if (this.closed) throw new Error('The web browsing runtime has closed.');
			if (request.name !== 'web.run' && request.name !== 'image.view')
				throw new Error('Unknown web tool.');
			if (!config.enabled)
				throw new Error('Enable web browsing and configure a SearXNG service in Settings first.');
			const endpoint = searxngSearchUrl(config.searxngUrl);
			if (request.name === 'image.view') {
				keys(request.arguments, ['target']);
				required(request.arguments.target, 'Image target', 2048);
			} else validateArguments(request.arguments);
			checkAbort(signal);
			run = this.run(request, endpoint);
			controller = new AbortController();
			const active = controller;
			abort = () => active.abort(cancelled());
			signal.addEventListener('abort', abort, { once: true });
			run.controllers.add(controller);
			timer = setTimeout(
				() =>
					active.abort(
						new Error(
							'Web browsing timed out after 45 seconds. Try fewer operations or another source.',
						),
					),
				this.timeoutMs,
			);
			if (request.name === 'image.view')
				return await this.viewImage(request.arguments, run, active.signal);
			const length = String(request.arguments.response_length ?? 'medium');
			const results: Record<string, unknown>[] = [];
			const images: ToolResult['content'] = [];
			for (const operation of operationNames) {
				for (const item of (request.arguments[operation] ?? []) as Record<string, unknown>[]) {
					checkAbort(active.signal);
					try {
						const result = await this.operation(
							operation,
							item,
							endpoint,
							run,
							active.signal,
							length,
						);
						if (typeof result.image_data_url === 'string') {
							if (
								images.reduce(
									(sum, item) => sum + (item.type === 'image' ? item.dataUrl.length : 0),
									0,
								) +
									result.image_data_url.length >
								20 * 1024 * 1024
							)
								throw new Error(
									'This call exceeded the PDF screenshot image budget. Request fewer pages in one call.',
								);
							images.push({
								type: 'image',
								dataUrl: result.image_data_url,
								name: String(result.image_name ?? 'PDF page.png'),
							});
							delete result.image_data_url;
							delete result.image_name;
						}
						results.push({
							operation,
							...result,
						});
					} catch (error) {
						checkAbort(active.signal);
						results.push({
							operation,
							error: error instanceof Error ? error.message.slice(0, 1000) : 'Web browsing failed.',
						});
					}
				}
			}
			const result = textResult(
				fitResults(results),
				results.every((result) => !!result.error),
			);
			result.content.push(...images);
			result.research = this.researchResults(results, run);
			return result;
		} catch (error) {
			return textResult(
				error instanceof Error ? error.message.slice(0, 1000) : 'Web browsing failed.',
				true,
			);
		} finally {
			if (timer) clearTimeout(timer);
			if (abort) signal.removeEventListener('abort', abort);
			if (controller) run?.controllers.delete(controller);
		}
	}

	cancel(runId: string): void {
		const run = this.runs.get(runId);
		if (run) {
			run.closed = true;
			for (const controller of run.controllers) controller.abort(cancelled());
			run.sources.clear();
			run.pages.clear();
			run.viewedImages.clear();
			for (const pdf of run.pdfs.values()) this.pdfCacheBytes -= pdf.size;
			run.pdfs.clear();
			this.runs.delete(runId);
		}
	}
	close(): void {
		this.closed = true;
		for (const id of this.runs.keys()) this.cancel(id);
		for (const controller of this.discoveryControllers) controller.abort(cancelled());
		this.discoveryControllers.clear();
		this.serviceConfigs.clear();
		this.pdf.close();
	}

	private run(request: ToolHostRequest, endpoint: URL): Run {
		for (const [id, run] of this.runs)
			if (!run.controllers.size && Date.now() - run.lastUsed > RUN_TTL) this.cancel(id);
		let run = this.runs.get(request.runId);
		const owner = JSON.stringify([request.workspaceId, request.threadId]);
		if (run && (run.owner !== owner || run.configUrl !== endpoint.href))
			throw new Error(
				'Web references do not belong to this conversation or SearXNG configuration.',
			);
		if (!run) {
			if (this.runs.size >= 32) {
				const oldest = [...this.runs].find(([, candidate]) => !candidate.controllers.size);
				if (!oldest) throw new Error('Too many web browsing runs are active.');
				this.cancel(oldest[0]);
			}
			run = {
				owner,
				configUrl: endpoint.href,
				prefix: randomUUID().slice(0, 8),
				counter: 0,
				sources: new Map(),
				pages: new Map(),
				pdfs: new Map(),
				controllers: new Set(),
				viewedImages: new Set(),
				lastUsed: Date.now(),
				closed: false,
			};
			this.runs.set(request.runId, run);
		}
		run.lastUsed = Date.now();
		return run;
	}
	private source(run: Run, value: Omit<Source, 'ref_id'>): Source {
		if (run.closed) throw cancelled();
		const existing = [...run.sources.values()].find(
			(source) => source.url === value.url && source.img_src === value.img_src,
		);
		if (existing) {
			const updated = { ...existing, ...value };
			run.sources.set(existing.ref_id, updated);
			return updated;
		}
		const source = { ref_id: `web_${run.prefix}_${++run.counter}`, ...value };
		run.sources.set(source.ref_id, source);
		if (run.sources.size > MAX_SOURCES) {
			const id = run.sources.keys().next().value!;
			run.sources.delete(id);
			run.pages.delete(id);
			run.viewedImages.delete(id);
			const pdf = run.pdfs.get(id);
			if (pdf) {
				this.pdfCacheBytes -= pdf.size;
				run.pdfs.delete(id);
			}
		}
		return source;
	}
	private getSource(run: Run, ref: string): Source {
		const source = run.sources.get(ref);
		if (!source)
			throw new Error(
				'Unknown or expired web reference. References belong to this run; open the source URL to revisit it.',
			);
		return source;
	}
	private researchResults(
		results: Record<string, unknown>[],
		run: Run,
	): { sources: ResearchSource[]; images: ResearchImage[] } {
		const sources = new Map<string, ResearchSource>();
		const images = new Map<string, ResearchImage>();
		const add = (value: Record<string, unknown>) => {
			if (typeof value.ref_id !== 'string') return;
			const source = run.sources.get(value.ref_id);
			if (!source) return;
			sources.set(source.ref_id, {
				id: source.ref_id,
				title: source.title,
				url: source.url,
				...(source.snippet ? { snippet: source.snippet } : {}),
				...(source.published_date ? { publishedDate: source.published_date } : {}),
				...(source.accessed_at ? { accessedAt: source.accessed_at } : {}),
				...(source.engines?.length || source.engine
					? { engines: source.engines ?? [source.engine!] }
					: {}),
			});
			if (source.img_src)
				images.set(source.ref_id, {
					id: source.ref_id,
					title: source.title,
					url: source.img_src,
					sourceUrl: source.url,
					...(source.thumbnail_src ? { thumbnailUrl: source.thumbnail_src } : {}),
					...(source.width && source.height ? { width: source.width, height: source.height } : {}),
					...(run.viewedImages.has(source.ref_id) ? { viewed: true } : {}),
				});
		};
		for (const result of results) {
			add(result);
			if (Array.isArray(result.results))
				for (const row of result.results) if (record(row)) add(row);
		}
		return { sources: [...sources.values()], images: [...images.values()] };
	}
	private async viewImage(
		args: Record<string, unknown>,
		run: Run,
		signal: AbortSignal,
	): Promise<ToolResult> {
		const target = String(args.target).trim();
		const existing = /^https?:\/\//i.test(target) ? undefined : this.getSource(run, target);
		if (existing && !existing.img_src)
			throw new Error(
				'This reference is a web page, not an image search result. Use an image_query ref_id or a public image URL.',
			);
		const url = publicPageUrl(existing?.img_src ?? target);
		const fetched = await this.fetch(url, false, signal, 'image');
		const mime = fetched.contentType.split(';')[0].trim().toLowerCase();
		const image = await decodeWebImage(fetched.bytes!, mime, signal);
		checkAbort(signal);
		const source =
			existing ??
			this.source(run, {
				title: fetched.url.pathname.split('/').pop()?.slice(0, 300) || fetched.url.hostname,
				url: fetched.url.href,
				img_src: fetched.url.href,
			});
		source.width = image.width;
		source.height = image.height;
		run.viewedImages.add(source.ref_id);
		const metadata = {
			ref_id: source.ref_id,
			title: source.title,
			url: fetched.url.href,
			source_url: source.url,
			width: image.width,
			height: image.height,
			sources_are_untrusted: true,
		};
		const result = textResult(metadata);
		result.content.push({ type: 'image', dataUrl: image.dataUrl, name: source.title });
		result.research = this.researchResults([metadata], run);
		return result;
	}
	private async operation(
		operation: Operation,
		args: Record<string, unknown>,
		endpoint: URL,
		run: Run,
		signal: AbortSignal,
		length: string,
	): Promise<Record<string, unknown>> {
		if (operation === 'search_query' || operation === 'image_query')
			return await this.search(args, endpoint, run, signal, length, operation === 'image_query');
		const ref = String(args.ref_id).trim();
		if (operation === 'open') {
			const page =
				run.pages.get(ref) ??
				(await this.openPage(
					run,
					/^https?:\/\//i.test(ref)
						? publicPageUrl(ref)
						: publicPageUrl(this.getSource(run, ref).url),
					signal,
				));
			return this.pageResult(
				run,
				page,
				Number(args.lineno ?? 1),
				length,
				args.pageno as number | undefined,
			);
		}
		const source =
			/^https?:\/\//i.test(ref) && operation === 'screenshot'
				? { url: publicPageUrl(ref).href }
				: this.getSource(run, ref);
		const page =
			run.pages.get(ref) ?? (await this.openPage(run, publicPageUrl(source.url), signal));
		if (operation === 'screenshot') {
			const cached = run.pdfs.get(page.ref_id);
			if (!cached)
				throw new Error(
					'Screenshots are available for PDF documents only. Open a PDF source first.',
				);
			const pageno = Number(args.pageno);
			if (pageno >= cached.pages.length)
				throw new Error(`This PDF has ${cached.pages.length} pages; pageno is zero-based.`);
			const image = await this.pdf.screenshot(cached.bytes, page.url, pageno, signal);
			return {
				ref_id: page.ref_id,
				url: page.url,
				title: page.title,
				pageno,
				total_pages: cached.pages.length,
				image_data_url: image.dataUrl,
				image_name: image.name,
			};
		}
		if (operation === 'click') {
			const link = page.links.find((link) => link.id === args.id);
			if (!link)
				throw new Error(
					'That numbered link is not available on this page. Open the page and use a returned link ID.',
				);
			return this.pageResult(
				run,
				await this.openPage(run, publicPageUrl(link.url), signal),
				1,
				length,
			);
		}
		const pattern = String(args.pattern).toLocaleLowerCase();
		const cachedPdf = run.pdfs.get(page.ref_id);
		if (cachedPdf) {
			const matches = cachedPdf.pages
				.flatMap((pdfPage, pageno) =>
					pdfPage.lines.flatMap((line, index) =>
						line.toLocaleLowerCase().includes(pattern)
							? [{ pageno, lineno: index + 1, text: line }]
							: [],
					),
				)
				.slice(0, 20);
			return {
				ref_id: page.ref_id,
				title: page.title,
				url: page.url,
				matches,
				total_pages: cachedPdf.pages.length,
			};
		}
		const matches = page.lines
			.flatMap((line, index) =>
				line.toLocaleLowerCase().includes(pattern) ? [{ lineno: index + 1, text: line }] : [],
			)
			.slice(0, 20);
		return {
			ref_id: page.ref_id,
			title: page.title,
			url: page.url,
			matches,
			total_lines: page.lines.length,
		};
	}
	private async search(
		args: Record<string, unknown>,
		endpoint: URL,
		run: Run,
		signal: AbortSignal,
		length: string,
		image = false,
	): Promise<Record<string, unknown>> {
		const q = String(args.q).trim();
		const domains = args.domains as string[] | undefined;
		const blocked = args.blocked_domains as string[] | undefined;
		const notices: string[] = [];
		let engines = args.engines as string[] | undefined;
		const categories = args.categories as string[] | undefined;
		const cachedInfo = this.serviceConfigs.get(endpoint.href);
		let info = cachedInfo && cachedInfo.expires > Date.now() ? cachedInfo.info : undefined;
		if (engines || categories || image || args.time_range) {
			info = await this.serviceInfo(endpoint, signal);
			if (engines) {
				for (const name of engines) {
					const engine = info.engines.find((engine) => engine.name === name);
					if (!engine)
						throw new Error(
							`Unknown SearXNG engine "${name}". Configured engines: ${info.engines.map((engine) => engine.name).join(', ')}.`,
						);
					if (image && !engine.categories.includes('images'))
						throw new Error(
							`Engine "${name}" does not advertise image search. Image engines: ${info.engines
								.filter((engine) => engine.categories.includes('images'))
								.map((engine) => engine.name)
								.join(', ')}.`,
						);
				}
			}
			if (categories)
				for (const category of categories)
					if (!info.categories.includes(category))
						throw new Error(
							`Unknown SearXNG category "${category}". Available categories: ${info.categories.join(', ')}.`,
						);
			if (image && !engines)
				engines = info.engines
					.filter((engine) => engine.enabled && engine.categories.includes('images'))
					.map((engine) => engine.name)
					.slice(0, 8);
			if (image && !engines?.length)
				throw new Error(
					'The configured SearXNG service has no enabled image engines. Select an advertised image engine explicitly or configure the service.',
				);
			if (args.time_range && !engines && !categories) {
				engines = info.engines
					.filter(
						(engine) =>
							engine.enabled && engine.timeRangeSupport && !engine.categories.includes('images'),
					)
					.map((engine) => engine.name)
					.slice(0, 8);
				if (!engines.length) {
					engines = undefined;
					notices.push(
						'No enabled text engines advertise time-range support; the native time_range hint may be ignored.',
					);
				}
			}
			const selected = info.engines.filter(
				(engine) =>
					engines?.includes(engine.name) ||
					(engine.enabled && categories?.some((category) => engine.categories.includes(category))),
			);
			if (args.time_range && selected.some((engine) => !engine.timeRangeSupport))
				notices.push(
					`Some selected engines do not advertise time-range support: ${selected
						.filter((engine) => !engine.timeRangeSupport)
						.map((engine) => engine.name)
						.join(', ')}.`,
				);
			if (Number(args.page ?? 1) > 1 && selected.some((engine) => !engine.paging))
				notices.push(
					`Some selected engines do not advertise paging: ${selected
						.filter((engine) => !engine.paging)
						.map((engine) => engine.name)
						.join(', ')}. Results do not establish has_more.`,
				);
			if (args.safesearch !== undefined && selected.some((engine) => !engine.safeSearch))
				notices.push(
					'Some selected engines do not advertise safe-search support; FreeLM does not guarantee their filtering.',
				);
			if (engines && categories)
				notices.push(
					'SearXNG combines explicit engines and categories additively; this request intentionally preserves that union.',
				);
		}
		const operators = [
			domains?.length
				? `(${domains.map((domain) => `site:${new URL(`https://${domain}`).hostname}`).join(' OR ')})`
				: '',
			...(blocked ?? []).map((domain) => `-site:${new URL(`https://${domain}`).hostname}`),
		].filter(Boolean);
		const query = [q, ...operators].join(' ');
		const url = new URL(endpoint);
		url.searchParams.set('q', query);
		url.searchParams.set('format', 'json');
		if (engines?.length) url.searchParams.set('engines', engines.join(','));
		if (categories?.length) url.searchParams.set('categories', categories.join(','));
		else if (!engines?.length) url.searchParams.set('categories', image ? 'images' : 'general');
		if (args.page !== undefined) url.searchParams.set('pageno', String(args.page));
		for (const key of ['language', 'time_range', 'safesearch', 'timeout_limit'])
			if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
		const response = await this.fetch(url, true, signal);
		const data = this.serviceJson(response);
		if (!record(data) || !Array.isArray(data.results))
			throw new Error('SearXNG returned an invalid search response: a results array is required.');
		const results: Source[] = [];
		const limit = Number(args.limit ?? (length === 'short' ? 4 : length === 'long' ? 10 : 6));
		const dateFiltered = !!(args.start_date || args.end_date || args.recency);
		const now = Date.now();
		const lower = Math.max(
			args.start_date ? strictDate(args.start_date, 'start_date') : -Infinity,
			args.recency ? now - Number(args.recency) * 86_400_000 : -Infinity,
		);
		const upper = Math.min(
			args.end_date ? strictDate(args.end_date, 'end_date') + 86_400_000 - 1 : Infinity,
			args.recency ? now : Infinity,
		);
		let unknownDates = 0;
		let excludedDates = 0;
		for (const raw of data.results.slice(0, 500)) {
			if (!record(raw) || typeof raw.url !== 'string') continue;
			let target: URL;
			try {
				target = publicPageUrl(raw.url);
			} catch {
				continue;
			}
			const matchDomain = (domain: string) => {
				const host = new URL(`https://${domain}`).hostname;
				const targetHost = target.hostname.replace(/\.$/, '');
				return targetHost === host || targetHost.endsWith(`.${host}`);
			};
			if ((domains && !domains.some(matchDomain)) || blocked?.some(matchDomain)) continue;
			const published =
				typeof raw.publishedDate === 'string'
					? raw.publishedDate
					: typeof raw.published_date === 'string'
						? raw.published_date
						: undefined;
			const timestamp = providerTimestamp(published);
			if (dateFiltered && !Number.isFinite(timestamp)) {
				unknownDates++;
				continue;
			}
			if (dateFiltered && (timestamp < lower || timestamp > upper)) {
				excludedDates++;
				continue;
			}
			const imageUrl = (value: unknown) => {
				if (typeof value !== 'string') return undefined;
				try {
					return publicPageUrl(value).href;
				} catch {
					return undefined;
				}
			};
			const img = image ? imageUrl(raw.img_src) : undefined;
			if (image && !img) continue;
			const clean = (value: unknown, max: number) =>
				typeof value === 'string'
					? nodeText(parseDocument(value.slice(0, 5000)) as unknown as HtmlNode)
							.replace(/\s+/g, ' ')
							.trim()
							.slice(0, max)
					: '';
			const title = clean(raw.title, 300);
			if (!title) continue;
			const source = this.source(run, {
				title,
				url: target.href,
				snippet: clean(raw.content, 800),
				...(published ? { published_date: published.slice(0, 100) } : {}),
				...(typeof raw.engine === 'string' ? { engine: raw.engine.slice(0, 100) } : {}),
				...(Array.isArray(raw.engines)
					? {
							engines: raw.engines
								.filter((name): name is string => typeof name === 'string')
								.slice(0, 20)
								.map((name) => name.slice(0, 100)),
						}
					: {}),
				...(img ? { img_src: img } : {}),
				...(typeof raw.resolution === 'string' && /^\d{1,5}\s*[x×]\s*\d{1,5}$/.test(raw.resolution)
					? {
							width: Number(raw.resolution.split(/[x×]/)[0]),
							height: Number(raw.resolution.split(/[x×]/)[1]),
						}
					: {}),
				...(imageUrl(raw.thumbnail_src ?? raw.thumbnail)
					? { thumbnail_src: imageUrl(raw.thumbnail_src ?? raw.thumbnail) }
					: {}),
			});
			if (!results.some((result) => result.ref_id === source.ref_id)) results.push(source);
			if (results.length >= limit) break;
		}
		if (dateFiltered)
			notices.push(
				'Date filtering uses provider publication metadata only, not independently verified publication, image creation, or arXiv version dates. Unknown dates are excluded.',
			);
		if (unknownDates)
			notices.push(
				`${unknownDates} inspected results with missing or invalid publication dates were excluded.`,
			);
		if (excludedDates)
			notices.push(
				`${excludedDates} inspected results fell outside the requested publication date bounds.`,
			);
		if (args.time_range)
			notices.push(
				'time_range is a native engine hint, not a strict publication date guarantee. Use start_date/end_date or recency for metadata filtering.',
			);
		if (data.results.length > 500)
			notices.push('Only the first 500 provider results were inspected.');
		const diagnostics = Array.isArray(data.unresponsive_engines)
			? boundedMetadata(data.unresponsive_engines)
			: [];
		const metadata: Record<string, unknown> = {};
		for (const key of ['suggestions', 'corrections', 'answers'])
			if (data[key] !== undefined) metadata[key] = boundedMetadata(data[key]);
		return {
			query: q,
			effective_query: typeof data.query === 'string' ? data.query.slice(0, 2000) : query,
			submitted_query: query,
			results,
			unresponsive_engines: diagnostics,
			...metadata,
			notices,
			...(Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length
				? {
						warning:
							'Some SearXNG engines did not respond; results may be incomplete. See unresponsive_engines for their reported reasons.',
					}
				: {}),
			...(info
				? {
						config_available_engines: info.engines.map((engine) => ({
							name: engine.name,
							enabled: engine.enabled,
							categories: engine.categories,
							paging: engine.paging,
							time_range_support: engine.timeRangeSupport,
							safesearch: engine.safeSearch,
						})),
					}
				: {}),
		};
	}
	private async openPage(run: Run, url: URL, signal: AbortSignal): Promise<Page> {
		const existing = [...run.pages.values()].find((page) => page.url === url.href);
		if (existing) return existing;
		const response = await this.fetch(url, false, signal);
		if (response.bytes) {
			const document = await this.pdf.read(response.bytes, response.url.href, signal);
			checkAbort(signal);
			const source = this.source(run, {
				title: document.title.slice(0, 300) || response.url.hostname,
				url: response.url.href,
				accessed_at: Date.now(),
			});
			const links: Link[] = [];
			const pages = document.pages.map((pdfPage) => ({
				lines: plainLines(pdfPage.lines.join('\n').slice(0, MAX_PAGE_CHARS)),
				links: pdfPage.links.flatMap((link) => {
					try {
						if (links.length >= 500) return [];
						const target = publicPageUrl(new URL(link.url, response.url).href);
						let numbered = links.find((existing) => existing.url === target.href);
						if (!numbered) {
							numbered = {
								id: links.length + 1,
								title: link.title.slice(0, 300),
								url: target.href,
							};
							links.push(numbered);
						}
						return [numbered];
					} catch {
						return [];
					}
				}),
			}));
			const page: Page = {
				...source,
				lines: pages[0]?.lines ?? [],
				links,
				truncated: document.truncated ?? false,
				pdf: true,
				total_pages: pages.length,
			};
			const estimatedTextBytes =
				pages.reduce(
					(sum, page) => sum + page.lines.reduce((sum, line) => sum + line.length * 2, 0),
					0,
				) + links.reduce((sum, link) => sum + (link.title.length + link.url.length) * 2, 0);
			this.cachePdf(run, source.ref_id, {
				bytes: response.bytes,
				pages,
				title: page.title,
				size: response.bytes.length + estimatedTextBytes,
			});
			run.pages.set(page.ref_id, page);
			return page;
		}
		const html = /(?:text\/html|application\/xhtml\+xml)/i.test(response.contentType);
		const extracted = extractWebPage(
			response.text,
			response.url,
			html,
			html ? await parseWebDocument(response.text, signal) : undefined,
		);
		const source = this.source(run, {
			title: extracted.title,
			url: extracted.url,
			accessed_at: Date.now(),
		});
		const page = { ...source, ...extracted };
		if (run.closed) throw cancelled();
		run.pages.set(page.ref_id, page);
		if (run.pages.size > 16) run.pages.delete(run.pages.keys().next().value!);
		return page;
	}
	private pageResult(
		run: Run,
		page: Page,
		lineno: number,
		length: string,
		pageno?: number,
	): Record<string, unknown> {
		if (!page.pdf) {
			if (pageno !== undefined) throw new Error('pageno is available for PDF documents only.');
			return pageResult(page, lineno, length);
		}
		const cached = run.pdfs.get(page.ref_id);
		if (!cached) throw new Error('The PDF cache expired. Open its source URL again.');
		const index = pageno ?? 0;
		if (index >= cached.pages.length)
			throw new Error(`This PDF has ${cached.pages.length} pages; pageno is zero-based.`);
		const selected = cached.pages[index];
		return {
			...pageResult({ ...page, lines: selected.lines, links: selected.links }, lineno, length),
			pageno: index,
			total_pages: cached.pages.length,
			pdf: true,
		};
	}
	private cachePdf(run: Run, ref: string, value: PdfCache): void {
		if (run.closed) throw cancelled();
		const evict = (owner: Run, id: string) => {
			const existing = owner.pdfs.get(id);
			if (!existing) return;
			this.pdfCacheBytes -= existing.size;
			owner.pdfs.delete(id);
			owner.pages.delete(id);
		};
		while (run.pdfs.size >= 2) evict(run, run.pdfs.keys().next().value!);
		while (this.pdfCacheBytes + value.size > MAX_PDF_CACHE_BYTES) {
			const owner = [...this.runs.values()].find((candidate) => candidate.pdfs.size > 0);
			if (!owner) break;
			evict(owner, owner.pdfs.keys().next().value!);
		}
		run.pdfs.set(ref, value);
		this.pdfCacheBytes += value.size;
	}
	private async fetch(
		initial: URL,
		service: boolean,
		signal: AbortSignal,
		kind: 'page' | 'image' = 'page',
	): Promise<FetchResult> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.fetchOnce(initial, service, signal, kind);
			} catch (error) {
				checkAbort(signal);
				const transient =
					error instanceof WebHttpError
						? [429, 502, 503, 504].includes(error.status)
						: ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT'].includes(
								String((error as NodeJS.ErrnoException)?.code ?? ''),
							);
				if (!service || attempt >= 1 || !transient) throw error;
				await retryBackoff(signal);
			}
		}
	}
	private async fetchOnce(
		initial: URL,
		service: boolean,
		signal: AbortSignal,
		kind: 'page' | 'image' = 'page',
	): Promise<FetchResult> {
		let url = initial;
		for (let redirects = 0; redirects <= 5; redirects++) {
			checkAbort(signal);
			if (!service) url = publicPageUrl(url.href);
			else if (url.origin !== initial.origin)
				throw new Error(
					'The SearXNG service redirected to another origin. Set its final service URL in Settings.',
				);
			const host = url.hostname.replace(/^\[|\]$/g, '');
			const addresses = isIP(host)
				? [{ address: host, family: isIP(host) }]
				: await abortable(this.resolve(host), signal);
			if (
				!addresses.length ||
				addresses.some(
					(address) => !isIP(address.address) || (!service && !publicWebAddress(address.address)),
				)
			)
				throw new Error(
					'This page resolves to a local or private network address and cannot be opened.',
				);
			const response = await this.response(url, addresses, signal, kind !== 'page');
			const status = response.statusCode ?? 0;
			if ([301, 302, 303, 307, 308].includes(status)) {
				const location = response.headers.location;
				response.destroy();
				if (!location) throw new Error('The web server returned a redirect without a destination.');
				if (redirects === 5) throw new Error('The page redirected too many times.');
				url = new URL(location, url);
				if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
					throw new Error('The web server returned an unsupported redirect destination.');
				continue;
			}
			if (status < 200 || status >= 300) {
				let detail = '';
				if (
					service &&
					/^application\/(?:json|[^;\s]+\+json)(?:[;\s]|$)/i.test(
						String(response.headers['content-type'] ?? ''),
					)
				) {
					try {
						const data = JSON.parse(
							new TextDecoder('utf-8', { fatal: true }).decode(
								await this.read(response, signal, 64 * 1024, 64 * 1024),
							),
						);
						const message = record(data)
							? typeof data.error === 'string'
								? data.error
								: record(data.error) && typeof data.error.message === 'string'
									? data.error.message
									: typeof data.message === 'string'
										? data.message
										: ''
							: '';
						detail = message ? ` Reported error: ${message.slice(0, 500)}` : '';
					} catch {
						checkAbort(signal);
					}
				}
				response.destroy();
				if (service && status === 403)
					throw new WebHttpError(
						`SearXNG returned HTTP 403. Enable json in search.formats in its settings.yml (for example [html, json]) and check service access restrictions.${detail}`,
						status,
					);
				throw new WebHttpError(
					`${service ? 'SearXNG' : 'The web page'} returned HTTP ${status}.${detail}`,
					status,
				);
			}
			const contentType = String(response.headers['content-type'] ?? 'text/plain');
			if (kind !== 'page') {
				if (!/^image\/(?:png|jpeg|webp)(?:[;\s]|$)/i.test(contentType)) {
					response.destroy();
					throw new Error(
						'Image inspection requires a PNG, JPEG or WebP response. HTML, SVG and other formats are not accepted.',
					);
				}
				const cap = MAX_WEB_IMAGE_BYTES;
				const bytes = await this.read(response, signal, cap, cap);
				return { url, text: '', bytes, contentType };
			}
			const pdf =
				!service &&
				(/^application\/pdf(?:[;\s]|$)/i.test(contentType) ||
					(/^application\/octet-stream(?:[;\s]|$)/i.test(contentType) &&
						/\.pdf$/i.test(url.pathname)));
			if (
				!service &&
				!pdf &&
				!/^(?:text\/[^;\s]+|application\/(?:xhtml\+xml|json|xml))(?:[;\s]|$)/i.test(contentType)
			) {
				response.destroy();
				throw new Error(
					'This page is not HTML, plain text, or a PDF document. Image, video and other binary downloads are not supported; image_query returns image metadata without loading remote rasters.',
				);
			}
			const bytes = await this.read(
				response,
				signal,
				pdf ? MAX_PDF_BYTES : MAX_DOWNLOAD_BYTES,
				pdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES,
			);
			if (pdf) return { url, text: '', bytes, contentType };
			const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
			try {
				return { url, text: new TextDecoder(charset, { fatal: true }).decode(bytes), contentType };
			} catch {
				throw new Error(`The web response could not be decoded as ${charset.slice(0, 100)}.`);
			}
		}
		throw new Error('The page redirected too many times.');
	}
	private async response(
		url: URL,
		addresses: Address[],
		signal: AbortSignal,
		image = false,
	): Promise<IncomingMessage> {
		return await new Promise<IncomingMessage>((resolve, reject) => {
			const request = this.request(
				url,
				{
					method: 'GET',
					agent: false,
					signal,
					headers: {
						Accept: image
							? 'image/png, image/jpeg, image/webp'
							: 'text/html, application/json, application/pdf, text/plain;q=0.9, */*;q=0.1',
						'Accept-Encoding': 'gzip, deflate, br',
						'User-Agent': 'FreeLM/0.1 (read-only web browsing)',
					},
					// Supplying the vetted address prevents a second DNS resolution when the socket opens.
					lookup: (_host, options, callback) => {
						if (typeof options === 'object' && options.all)
							(callback as unknown as (error: null, addresses: Address[]) => void)(null, addresses);
						else callback(null, addresses[0].address, addresses[0].family);
					},
				},
				resolve,
			);
			request.on('error', reject);
			request.end();
		});
	}
	private async read(
		response: IncomingMessage,
		signal: AbortSignal,
		wireCap: number,
		decodedCap: number,
	): Promise<Buffer> {
		if (Number(response.headers['content-length']) > wireCap) {
			response.destroy();
			throw new Error(
				`The web response is too large to read (${wireCap / 1024 / 1024} MiB download limit).`,
			);
		}
		let wireBytes = 0;
		const wireLimit = (chunk: Buffer) => {
			wireBytes += chunk.length;
			if (wireBytes > wireCap)
				response.destroy(
					new Error(`The web response exceeded the ${wireCap / 1024 / 1024} MiB download limit.`),
				);
		};
		response.on('data', wireLimit);
		const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
		const decoder =
			encoding === 'gzip'
				? createGunzip()
				: encoding === 'deflate'
					? createInflate()
					: encoding === 'br'
						? createBrotliDecompress()
						: undefined;
		if (encoding && encoding !== 'identity' && !decoder) {
			response.destroy();
			throw new Error(`Unsupported web response encoding: ${encoding}.`);
		}
		const stream = decoder ? response.pipe(decoder) : response;
		const stop = () => {
			response.destroy(cancelled());
			if (decoder) decoder.destroy(cancelled());
		};
		const forwardError = (error: Error) => decoder?.destroy(error);
		response.on('error', forwardError);
		signal.addEventListener('abort', stop, { once: true });
		const chunks: Buffer[] = [];
		let bytes = 0;
		try {
			for await (const raw of stream) {
				checkAbort(signal);
				const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
				bytes += chunk.length;
				if (bytes > decodedCap)
					throw new Error(
						`The decoded web response exceeded the ${decodedCap / 1024 / 1024} MiB limit.`,
					);
				chunks.push(chunk);
			}
			checkAbort(signal);
			return Buffer.concat(chunks);
		} finally {
			signal.removeEventListener('abort', stop);
			response.removeListener('data', wireLimit);
			response.removeListener('error', forwardError);
			response.destroy();
			decoder?.destroy();
		}
	}
}

function pageResult(page: Page, lineno: number, length: string): Record<string, unknown> {
	const start = Math.min(Math.max(0, lineno - 1), Math.max(0, page.lines.length - 1));
	const count = length === 'short' ? 80 : length === 'long' ? 240 : 140;
	const lines = page.lines.slice(start, start + count);
	return {
		ref_id: page.ref_id,
		title: page.title,
		url: page.url,
		total_lines: page.lines.length,
		content: lines.map((line, index) => `L${start + index + 1}: ${line}`).join('\n'),
		links: page.links.slice(0, 30),
		truncated: page.truncated || start > 0 || start + lines.length < page.lines.length,
	};
}
function fitResults(results: Record<string, unknown>[]): Record<string, unknown> {
	const output = { results, sources_are_untrusted: true, truncated: false, omitted_operations: 0 };
	let encoded = JSON.stringify(output);
	while (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) {
		output.truncated = true;
		const largest = results
			.filter((result) => typeof result.content === 'string' && result.content.length > 200)
			.sort((a, b) => String(b.content).length - String(a.content).length)[0];
		if (largest) {
			largest.content = String(largest.content).slice(
				0,
				Math.floor(String(largest.content).length / 2),
			);
			largest.truncated = true;
		} else {
			const links = results
				.filter((result) => Array.isArray(result.links) && result.links.length)
				.sort((a, b) => JSON.stringify(b.links).length - JSON.stringify(a.links).length)[0];
			if (links) {
				links.links = (links.links as Link[]).slice(
					0,
					Math.floor((links.links as Link[]).length / 2),
				);
				links.truncated = true;
			} else {
				const search = results
					.filter((result) => Array.isArray(result.results) && result.results.length > 1)
					.sort((a, b) => JSON.stringify(b.results).length - JSON.stringify(a.results).length)[0];
				if (search) {
					search.results = (search.results as Source[]).slice(
						0,
						Math.floor((search.results as Source[]).length / 2),
					);
					search.truncated = true;
				} else {
					const metadata = results
						.flatMap((result) =>
							[
								'unresponsive_engines',
								'suggestions',
								'corrections',
								'answers',
								'config_available_engines',
								'notices',
								'matches',
							].flatMap((key) =>
								result[key] !== undefined && JSON.stringify(result[key]).length > 500
									? [{ result, key, size: JSON.stringify(result[key]).length }]
									: [],
							),
						)
						.sort((a, b) => b.size - a.size)[0];
					if (metadata) {
						const value = metadata.result[metadata.key];
						metadata.result[metadata.key] = Array.isArray(value)
							? value.slice(0, Math.floor(value.length / 2))
							: {
									truncated: true,
									notice: 'Provider metadata exceeded this call’s response budget.',
								};
						metadata.result.truncated = true;
					} else if (!shrinkFixedResults(results)) {
						// A final bounded fallback keeps JSON valid and never shortens a source URL.
						results.pop();
						output.omitted_operations++;
					}
				}
			}
		}
		encoded = JSON.stringify(output);
	}
	return output;
}
function shrinkFixedResults(results: Record<string, unknown>[]): boolean {
	const candidates: { object: Record<string, unknown>; key: string; size: number }[] = [];
	for (const result of results) {
		for (const key of ['query', 'effective_query', 'submitted_query', 'title'])
			if (typeof result[key] === 'string' && result[key].length > 100)
				candidates.push({ object: result, key, size: Buffer.byteLength(result[key], 'utf8') });
		if (Array.isArray(result.results))
			for (const source of result.results)
				if (record(source)) {
					for (const key of ['title', 'snippet'])
						if (typeof source[key] === 'string' && source[key].length > 100)
							candidates.push({
								object: source,
								key,
								size: Buffer.byteLength(source[key], 'utf8'),
							});
				}
	}
	const largest = candidates.sort((a, b) => b.size - a.size)[0];
	if (largest) {
		const value = String(largest.object[largest.key]);
		largest.object[largest.key] = value.slice(0, Math.floor(value.length / 2));
		largest.object.truncated = true;
		return true;
	}
	for (const result of results)
		if (Array.isArray(result.results))
			for (const source of result.results)
				if (record(source)) {
					if (source.thumbnail_src) {
						delete source.thumbnail_src;
						source.truncated = true;
						return true;
					}
					if (Array.isArray(source.engines) && source.engines.length > 1) {
						source.engines = source.engines.slice(0, Math.floor(source.engines.length / 2));
						source.truncated = true;
						return true;
					}
				}
	return false;
}
