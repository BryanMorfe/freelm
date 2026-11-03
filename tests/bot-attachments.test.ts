import { describe, expect, it } from 'vitest';
import { validBotAttachments, MAX_BOT_ATTACHMENT_BYTES } from '../src/lib/bot-attachments';
const file = (bytes = 3, type = 'application/octet-stream') => ({ name: 'synthetic.bin', type, dataUrl: `data:${type};base64,${Buffer.alloc(bytes).toString('base64')}` });
describe('bounded bot attachments', () => {
 it('accepts empty and arbitrary file payloads without claiming model compatibility', () => {
  expect(validBotAttachments([])).toBe(true);
  expect(validBotAttachments([file(0), file(3, 'application/pdf')])).toBe(true);
 });
 it('handles maximum payloads without recursion or unbounded acceptance', () => {
  const maximum = file(MAX_BOT_ATTACHMENT_BYTES);
  expect(validBotAttachments([maximum, maximum])).toBe(true);
  expect(validBotAttachments([maximum, maximum, file(1)])).toBe(false);
  expect(validBotAttachments([file(MAX_BOT_ATTACHMENT_BYTES + 1)])).toBe(false);
 });
 it('rejects URLs, paths, MIME mismatches, malformed base64 and excess count', () => {
  for (const dataUrl of ['https://example.invalid/a', 'file:///tmp/a', '../a', 'data:text/html;base64,YQ==', 'data:application/octet-stream;base64,@@==']) {
   expect(validBotAttachments([{ ...file(), dataUrl }])).toBe(false);
  }
  expect(validBotAttachments(Array.from({length:7}, () => file()))).toBe(false);
 });
});
