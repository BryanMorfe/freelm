import { it, expect } from 'vitest';
import { mobileFixture } from '../../scripts/mobile-fixture';
it('rechecks authorization inside mailbox mutation after stalled host identity loading',async()=>{
  let hold=false,authorized=true,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const fixture=await mobileFixture({beforeIdentity:async()=>{if(hold){entered();await gate;}}});
  try {
    hold=true;
    const send=fixture.bots.command({type:'send',conversationId:'welcome',messageId:'revoked-before-commit',content:'Must never execute'},true,()=>{if(!authorized)throw Error('Device revoked');});
    const rejection=expect(send).rejects.toThrow('Device revoked');
    await waiting;authorized=false;hold=false;release();await rejection;
    expect((await fixture.bots.snapshot()).conversations[0].messages.some(m=>m.id==='revoked-before-commit')).toBe(false);
  } finally {hold=false;release();await fixture.close();}
});
