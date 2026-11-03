import type { Attachment } from '../types';
export const MAX_BOT_ATTACHMENTS = 6;
export const MAX_BOT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_BOT_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;
/** Strict inline payloads: no paths, remote URLs or executable resource resolution. */
export function validBotAttachments(value: unknown): value is Attachment[] {
 if (value === undefined) return true;
 if (!Array.isArray(value) || value.length > MAX_BOT_ATTACHMENTS) return false;
 let total = 0;
 return value.every(a => {
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name.length || a.name.length > 256 || /[\x00-\x1f]/.test(a.name) || typeof a.type !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.type) || typeof a.dataUrl !== 'string' || a.dataUrl.length > Math.ceil(MAX_BOT_ATTACHMENT_BYTES / 3) * 4 + 256) return false;
  const prefix = `data:${a.type};base64,`;
  if (!a.dataUrl.startsWith(prefix)) return false;
  const data = a.dataUrl.slice(prefix.length);
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  total += bytes;
  return bytes <= MAX_BOT_ATTACHMENT_BYTES && total <= MAX_BOT_ATTACHMENT_TOTAL_BYTES;
 });
}
