import { expect, it, vi } from 'vitest';
import path from 'node:path';
import { botProviderMessagesWithPdf } from '../electron/bot-pdf-attachments';
import { PdfProcessor } from '../electron/tools/pdf';
import { webPdfFixture } from './fixtures/web-pdf';
import { initialState } from '../src/lib/state';
import type { BotMessage } from '../src/bot-types';
const project = (bytes: Uint8Array, signal = new AbortController().signal) => {
 const message: BotMessage = {id:'pdf',role:'user',content:'Read',attachments:[{name:'test.pdf',type:'application/pdf',dataUrl:'data:application/pdf;base64,'+Buffer.from(bytes).toString('base64')}],status:'completed',createdAt:1,updatedAt:1,reactions:[]};
 return botProviderMessagesWithPdf([message],{hostId:'home',botId:'bot'},initialState().connections[0],'test',signal,new PdfProcessor({workerPath:path.resolve('dist-electron/web-pdf-worker.mjs')}));
};
it('extracts local synthetic PDF text without sending PDF bytes', async()=>{
 const result=JSON.stringify(await project(webPdfFixture({text:['Synthetic attachment evidence.'],javascript:true})));
 expect(result).toContain('Synthetic attachment evidence.'); expect(result).not.toContain('base64');
 expect(result).toContain('bot-attachment:pdf:0');
}, 15_000);
it('reports no extractable text honestly',async()=>{
 expect(JSON.stringify(await project(webPdfFixture({text:['']})))).toContain('no extractable text');
});
it('preserves delivery on invalid PDF extraction failure',async()=>{
 expect(JSON.stringify(await project(new Uint8Array([1,2,3])))).toContain('extraction failed');
});
it('aborts before extracting or projecting provider input',async()=>{
 const controller=new AbortController(); controller.abort();
 await expect(project(webPdfFixture(),controller.signal)).rejects.toThrow();
});

it('bounds more than seven historical PDFs and prioritizes the newest attachment', async()=>{
 const read = vi.fn(async(_bytes: Uint8Array)=>({title:'synthetic',pages:[{lines:['Extracted newest evidence'],links:[]}]}));
 const close=vi.fn();
 const history: BotMessage[] = Array.from({length:9},(_,index)=>({id:`pdf-${index}`,role:'user',content:'Read',attachments:[{name:`${index}.pdf`,type:'application/pdf',dataUrl:'data:application/pdf;base64,'+Buffer.from(String(index)).toString('base64')}],status:'completed',createdAt:index,updatedAt:index,reactions:[]}));
 const result=await botProviderMessagesWithPdf(history,{hostId:'home',botId:'bot'},initialState().connections[0],'test',new AbortController().signal,{read,close} as unknown as PdfProcessor);
 expect(read).toHaveBeenCalledTimes(6);
 expect(Buffer.from(read.mock.calls[0][0] as Uint8Array).toString()).toBe('8');
 expect(JSON.stringify(result.at(-1))).toContain('Extracted newest evidence');
 expect(JSON.stringify(result[0])).toContain('analysis omitted');
 expect(close).toHaveBeenCalledOnce();
});
