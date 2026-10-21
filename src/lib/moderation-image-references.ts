import type { WireRequest, WireResponse } from '../types';
import type { ModerationMediaKind } from '../moderation-types';
import { moderateImagePayload } from './moderation-image-payload';
import { AVIF_HEADER_BYTES, inspectAvif, requireStaticAvif } from './avif';

export type ModerationImageReferenceDownloader = (
	url: string,
	signal?: AbortSignal,
	kind?: ModerationMediaKind,
) => Promise<WireResponse>;

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 16;
const BASE64_SLICE = 64 * 1024;
const REFERENCE_FIELDS = new Set([
	'image',
	'image[]',
	'images',
	'images[]',
	'image_url',
	'image_urls',
	'input_image',
	'input_images',
	'input_reference',
	'input_references',
	'reference',
	'references',
	'reference_image',
	'reference_images',
]);
const VALUE_FIELDS = ['image_url', 'url', 'dataUrl', 'base64', 'b64_json'];
const REFERENCE_METADATA = new Set(['name', 'type', 'mimeType', 'mime_type', 'detail']);

interface ImageSource {
	value: string;
	mime?: string;
	base64: boolean;
}

function fail(message: string): never {
	throw new Error(`Image input moderation could not inspect the reference images. ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEditRoute(path: string): boolean {
	try {
		const route = decodeURIComponent(new URL(path, 'https://moderation-route.invalid').pathname)
			.replace(/\/+$/, '')
			.replace(/^\/v1(?=\/)/, '');
		return route === '/images/edits';
	} catch {
		return false;
	}
}

function referenceLikeField(name: string): boolean {
	return (
		/image|reference|attachment|^(?:input|files?|source)$/i.test(name) &&
		!/(?:^|_)(?:format|size|quality|width|height|dimensions?|compression|count|seed)(?:_|$)/i.test(
			name,
		)
	);
}

/** Reference-bearing generation requests need the same contextual check as image edits. */
export function isImageEditRequest(request: WireRequest): boolean {
	if (request.method !== 'POST') return false;
	if (isEditRoute(request.path)) return true;
	return (
		(Array.isArray(request.form) &&
			request.form.some(
				(field) =>
					object(field) &&
					typeof field.name === 'string' &&
					field.name !== 'mask' &&
					(REFERENCE_FIELDS.has(field.name) ||
						referenceLikeField(field.name) ||
						field.file !== undefined),
			)) ||
		(object(request.body) &&
			Object.keys(request.body).some(
				(name) => name !== 'mask' && (REFERENCE_FIELDS.has(name) || referenceLikeField(name)),
			))
	);
}

function sourcesOf(request: WireRequest): ImageSource[] {
	const sources: ImageSource[] = [];
	const add = (value: unknown, depth = 0): void => {
		if (depth > 3) fail('An image reference has an unsupported nested representation.');
		if (Array.isArray(value)) {
			if (!value.length) fail('An image reference list is empty.');
			if (value.length > MAX_IMAGES) fail('Use at most 16 reference images.');
			for (const item of value) add(item, depth + 1);
			return;
		}
		if (typeof value === 'string') {
			if (!value) fail('An image reference is empty.');
			sources.push({ value, base64: false });
		} else if (object(value)) {
			const carriers = VALUE_FIELDS.filter((field) => Object.hasOwn(value, field));
			if (
				carriers.length !== 1 ||
				Object.keys(value).some(
					(field) => !VALUE_FIELDS.includes(field) && !REFERENCE_METADATA.has(field),
				)
			)
				fail('An image reference has an unsupported or ambiguous representation.');
			const field = carriers[0];
			if (field === 'image_url' && object(value[field])) {
				add(value[field], depth + 1);
				return;
			}
			if (typeof value[field] !== 'string' || !value[field])
				fail('An image reference has invalid image data.');
			const mime = value.mimeType ?? value.mime_type ?? value.type;
			if (mime !== undefined && typeof mime !== 'string')
				fail('An image reference has an invalid content type.');
			sources.push({
				value: value[field],
				base64: field === 'base64' || field === 'b64_json',
				mime:
					typeof mime === 'string' && !['input_image', 'image_url'].includes(mime)
						? mime
						: undefined,
			});
		} else {
			fail('An image reference has invalid image data.');
		}
		if (sources.length > MAX_IMAGES) fail('Use at most 16 reference images.');
	};
	if (request.form !== undefined) {
		if (!Array.isArray(request.form)) fail('The image request has invalid form fields.');
		for (const field of request.form) {
			if (!object(field) || typeof field.name !== 'string')
				fail('The image request has invalid form fields.');
			if (field.name === 'mask') continue; // A transparency mask is not a depicted source person.
			if (REFERENCE_FIELDS.has(field.name)) {
				if (field.file !== undefined && field.value !== undefined)
					fail('An image reference has ambiguous file and text values.');
				add(field.file ?? field.value);
			} else if (field.file !== undefined || referenceLikeField(field.name)) {
				fail('The image request contains an unsupported reference field.');
			}
		}
	}
	if (request.body !== undefined) {
		if (!object(request.body)) fail('The image request has an invalid JSON body.');
		for (const [name, value] of Object.entries(request.body)) {
			if (name === 'mask') continue;
			if (REFERENCE_FIELDS.has(name)) add(value);
			else if (referenceLikeField(name))
				fail('The image request contains an unsupported reference field.');
		}
	}
	if (isEditRoute(request.path) && !sources.length)
		fail('An image-edit request must provide inspectable reference images.');
	return sources;
}

function normalizedMime(value?: string): string | undefined {
	if (!value) return undefined;
	const mime = value.split(';', 1)[0].trim().toLowerCase();
	if (mime === 'application/octet-stream') return undefined;
	if (mime === 'image/jpg') return 'image/jpeg';
	if (mime === 'image/x-png') return 'image/png';
	return mime;
}

function bytesAt(base64: string, offset: number, length: number): string {
	const aligned = Math.floor(offset / 3) * 3;
	const start = (aligned / 3) * 4;
	const end = Math.ceil((offset + length) / 3) * 4;
	return atob(base64.slice(start, end)).slice(offset - aligned, offset - aligned + length);
}

function uint32(value: string, offset: number, littleEndian = false): number {
	const bytes = Array.from({ length: 4 }, (_, index) => value.charCodeAt(offset + index));
	if (littleEndian) bytes.reverse();
	return (((bytes[0] * 256 + bytes[1]) * 256 + bytes[2]) * 256 + bytes[3]) >>> 0;
}

async function requireStaticImage(
	base64: string,
	bytes: number,
	mime: string,
	signal?: AbortSignal,
): Promise<void> {
	if (mime === 'image/jpeg') return;
	if (mime === 'image/avif') {
		try {
			await requireStaticAvif(
				(offset, length) =>
					Uint8Array.from(bytesAt(base64, offset, length), (byte) => byte.charCodeAt(0)),
				bytes,
				signal,
			);
		} catch (error) {
			signal?.throwIfAborted();
			fail(error instanceof Error ? error.message : 'An AVIF reference has invalid image data.');
		}
		return;
	}
	const png = mime === 'image/png';
	let offset = png ? 8 : 12;
	let chunks = 0;
	if (!png && uint32(bytesAt(base64, 4, 4), 0, true) + 8 !== bytes)
		fail('A WebP reference has invalid image data.');
	while (offset < bytes) {
		signal?.throwIfAborted();
		if (++chunks > 65536 || bytes - offset < (png ? 12 : 8))
			fail('A reference image has invalid image data.');
		const header = bytesAt(base64, offset, 8);
		const type = png ? header.slice(4) : header.slice(0, 4);
		const length = uint32(header, png ? 0 : 4, !png);
		const size = png ? length + 12 : length + 8 + (length % 2);
		if (size > bytes - offset) fail('A reference image has truncated image data.');
		if (
			(png && ['acTL', 'fcTL', 'fdAT'].includes(type)) ||
			(!png && ['ANIM', 'ANMF'].includes(type)) ||
			(!png &&
				type === 'VP8X' &&
				length > 0 &&
				(bytesAt(base64, offset + 8, 1).charCodeAt(0) & 2) !== 0)
		)
			fail('Convert animated image references to static PNG, JPEG, WebP, or AVIF before editing.');
		if (png && chunks === 1 && (type !== 'IHDR' || length !== 13))
			fail('A PNG reference is missing its image header.');
		offset += size;
		if (png && type === 'IEND') {
			if (length || offset !== bytes) fail('A PNG reference has invalid image data.');
			return;
		}
		if (chunks % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	if (png) fail('A PNG reference is missing its image ending.');
}

async function checkedImage(
	value: string,
	declaredMime: string | undefined,
	signal?: AbortSignal,
): Promise<{ url: string; bytes: number }> {
	if (!value || value.length % 4 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
		fail('Reference images must be valid base64 within the 32 MiB image limit.');
	const bytes = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
	if (!bytes || bytes > MAX_IMAGE_BYTES) fail('A reference image exceeds the 32 MiB image limit.');
	for (let offset = 0; offset < value.length; offset += BASE64_SLICE) {
		signal?.throwIfAborted();
		const chunk = value.slice(offset, offset + BASE64_SLICE);
		const last = offset + BASE64_SLICE >= value.length;
		if (!(last ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk))
			fail('A reference image has invalid base64 encoding.');
		if (!last) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	let header: string;
	try {
		header = atob(value.slice(0, Math.min(64, value.length)));
	} catch {
		fail('A reference image has invalid base64 encoding.');
	}
	const mime = header.startsWith('\x89PNG\r\n\x1a\n')
		? 'image/png'
		: header.startsWith('\xff\xd8\xff')
			? 'image/jpeg'
			: header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
				? 'image/webp'
				: inspectAvif(
							Uint8Array.from(bytesAt(value, 0, Math.min(bytes, AVIF_HEADER_BYTES)), (byte) =>
								byte.charCodeAt(0),
							),
					  )
					? 'image/avif'
					: undefined;
	if (!mime)
		fail(
			'Use PNG, JPEG, static WebP, or static AVIF references; convert other image formats to a static image.',
		);
	if (normalizedMime(declaredMime) && normalizedMime(declaredMime) !== mime)
		fail('A reference image content type does not match its image data.');
	await requireStaticImage(value, bytes, mime, signal);
	return { url: `data:${mime};base64,${value}`, bytes };
}

/** Inspect every reference with bounded, lossless copies; never mutate the generation request. */
export async function collectModerationImageReferences(
	request: WireRequest,
	_download: ModerationImageReferenceDownloader,
	signal?: AbortSignal,
): Promise<string[]> {
	signal?.throwIfAborted();
	const sources = sourcesOf(request);
	const images: string[] = [];
	let bytes = 0;
	for (const source of sources) {
		signal?.throwIfAborted();
		let image: { url: string; bytes: number };
		if (source.base64) {
			image = await checkedImage(source.value, source.mime, signal);
		} else if (/^data:/i.test(source.value)) {
			const comma = source.value.indexOf(',');
			const metadata = source.value.slice(0, comma);
			if (comma < 0 || !/^data:image\/[a-z0-9.+-]+;base64$/i.test(metadata))
				fail('An image reference must use a base64 image data URL.');
			const mime = metadata.slice(5, -7);
			if (normalizedMime(source.mime) && normalizedMime(source.mime) !== normalizedMime(mime))
				fail('An image reference has conflicting content types.');
			image = await checkedImage(source.value.slice(comma + 1), mime, signal);
		} else {
			let url: URL;
			try {
				url = new URL(source.value);
			} catch {
				fail('Use embedded images or HTTP(S) image URLs without credentials.');
			}
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.hash ||
				source.value.length > 8192
			)
				fail('Use HTTP(S) image URLs without credentials or fragments.');
			// A mutable URL could change after evaluation but before the image service
			// fetches it. Require embedded bytes so both services inspect the same image.
			fail(
				'Download and attach the reference image before editing; remote image URLs cannot be inspected consistently.',
			);
		}
		bytes += image.bytes;
		if (bytes > MAX_BATCH_BYTES) fail('Reference images exceed the 64 MiB batch limit.');
		images.push(await moderateImagePayload(image.url, signal));
	}
	signal?.throwIfAborted();
	return images;
}
