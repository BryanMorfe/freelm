import { describe, expect, it, vi } from 'vitest';
import { botProviderMessages } from '../src/lib/bot-provider-attachments';
import type { BotMessage } from '../src/bot-types';
import type { Connection } from '../src/types';
vi.mock('../src/lib/catalog', () => ({ assertModelSupports: (_c: unknown, model: string) => { if (model === 'text') throw Error('unsupported'); } }));
const self = { hostId: 'home', botId: 'bot' };
const attachment = (type: string, data = 'eA==') => ({name:'sample',type,dataUrl:`data:${type};base64,${data}`});
const message = (attachments: BotMessage['attachments']): BotMessage => ({id:'m',role:'user',content:'',attachments,status:'completed',createdAt:1,updatedAt:1,reactions:[]});
describe('Bot provider attachment routing', () => {
 it.each(['responses', 'completions'])('routes raster images to configured %s vision model', chatApi => {
  const result = botProviderMessages([message([attachment('image/png')])],self,{chatApi} as Connection,'vision');
  expect(JSON.stringify(result)).toContain('data:image/png;base64,eA==');
  expect(JSON.stringify(result)).toContain(chatApi === 'responses' ? 'input_image' : 'image_url');
 });
 it('keeps unsupported bytes out and explains the limitation', () => {
  const result = JSON.stringify(botProviderMessages([message([attachment('image/png'),attachment('application/pdf'),attachment('audio/mpeg'),attachment('video/mp4'),attachment('image/svg+xml')])],self,{} as Connection,'text'));
  expect(result).not.toContain('base64'); expect(result).toContain('unavailable for analysis');
 });
 it('decodes text and JSON using existing text infrastructure', () => {
  const result = JSON.stringify(botProviderMessages([message([attachment('text/plain','aGVsbG8='),attachment('application/json','e30=')])],self,{} as Connection,'text'));
  expect(result).toContain('hello'); expect(result).toContain('document'); expect(result).not.toContain('base64');
 });
 it('does not route bot supplied images into provider assistant content', () => {
  const m = {...message([attachment('image/png')]),role:'bot' as const,author:self};
  expect(JSON.stringify(botProviderMessages([m],self,{} as Connection,'vision'))).not.toContain('base64');
 });
});
