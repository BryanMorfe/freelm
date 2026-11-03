import { afterEach, describe, expect, it } from 'vitest';
import { MobileAccess } from '../../electron/mobile-access';
import { mobileFixture } from '../../scripts/mobile-fixture';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
describe('mobile scoped access', () => {
    it('expires invitations and sessions, rejects replay, and revokes grants', () => {
        let now = 0; const access = new MobileAccess(() => now);
        const expired = access.invite(); now = 120_001;
        expect(() => access.exchange(expired.id, expired.secret)).toThrow();
        const invitation = access.invite();
        expect(() => access.exchange(invitation.id, 'wrong')).toThrow();
        const grant = access.exchange(invitation.id, invitation.secret);
        expect(() => access.exchange(invitation.id, invitation.secret)).toThrow();
        expect(access.authorize(grant.token)?.id).toBe(grant.sessionId);
        access.revoke(grant.sessionId); expect(access.authorize(grant.token)).toBeUndefined();
        const next = access.invite(), session = access.exchange(next.id,next.secret);
        now += 8 * 60 * 60_000; expect(access.authorize(session.token)).toBeUndefined();
    });
    it('pairs with the actual host, reads existing threads, sends once, syncs settings with conflict checks, and denies task access', async () => {
        const fixture = await mobileFixture(); cleanups.push(fixture.close);
        const invitation = await fixture.invite();
        const call = (route: string, body?: unknown, token?: string) => fetch(fixture.endpoint + route, {
            method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
            ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        });
        expect((await call('/mobile/invitations',{})).status).toBe(401);
        expect((await call('/mobile/pair',{...invitation,hostId:'imposter'})).status).toBe(400);
        const pair = await call('/mobile/pair',invitation); expect(pair.status).toBe(200);
        const grant = await pair.json();
        expect((await call('/mobile/pair',invitation)).status).toBe(401);
        expect((await call('/bots',undefined,grant.token)).status).toBe(401);
        expect((await call('/mobile/tasks',{},grant.token)).status).toBe(403);
        const snapshot = await (await call('/mobile/snapshot',undefined,grant.token)).json();
        expect(snapshot.conversations[0].messages[0].id).toBe('existing-message');
        expect(snapshot.connections).toBeUndefined(); expect(snapshot.bots[0].identity).toBeUndefined();
        const operation = {hostId:'synthetic-mac',conversationId:'welcome',messageId:'mobile-message',content:'Hello from iOS'};
        expect((await call('/mobile/send',{...operation,hostId:'other'},grant.token)).status).toBe(400);
        expect((await call('/mobile/send',operation,grant.token)).status).toBe(200);
        expect((await call('/mobile/send',operation,grant.token)).status).toBe(200);
        expect((await call('/mobile/send',{...operation,content:'different'},grant.token)).status).toBe(400);
        await expect.poll(async () => {
            const state = await (await call('/mobile/snapshot',undefined,grant.token)).json();
            return state.conversations[0].messages.some((m: {role:string;status:string;content:string}) => m.role === 'bot' && m.status === 'completed' && m.content.includes('isolated test provider'));
        }, {timeout: 10000}).toBe(true);
        const final = await (await call('/mobile/snapshot',undefined,grant.token)).json();
        expect(final.conversations[0].messages.filter((m: {id:string}) => m.id === 'mobile-message')).toHaveLength(1);
        const prefs = await (await call('/mobile/preferences',undefined,grant.token)).json();
        expect(prefs.sound).toEqual({muted:false,volume:1});
        expect((await call('/mobile/preferences',{revision:prefs.revision,sound:{muted:true,volume:0.2}},grant.token)).status).toBe(200);
        expect((await fixture.authority.loadNotificationPreferences()).botResponseSound).toEqual({muted:true,volume:0.2});
        expect((await call('/mobile/preferences',{revision:prefs.revision,sound:{muted:false,volume:0.8}},grant.token)).status).toBe(409);
        expect((await call('/mobile/preferences',{revision:'x',sound:{muted:false,volume:2}},grant.token)).status).toBe(400);
        await fixture.owner('/mobile/revoke',{id:grant.sessionId});
        expect((await call('/mobile/snapshot',undefined,grant.token)).status).toBe(401);
    });
});

it('delivers bounded attachment-only payloads through the actual mobile endpoint and retains auth', async()=>{
 const fixture=await mobileFixture(); cleanups.push(fixture.close);
 const call=(body:unknown,token?:string)=>fetch(fixture.endpoint+'/mobile/send',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 const invitation=await fixture.invite();
 const pair=await fetch(fixture.endpoint+'/mobile/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(invitation)});
 const grant=await pair.json();
 // Larger than the previous 256KiB facade body cap, but safely below per-file limits.
 const file={name:'synthetic.bin',type:'application/octet-stream',dataUrl:'data:application/octet-stream;base64,'+Buffer.alloc(300*1024,65).toString('base64')};
 const operation={hostId:'synthetic-mac',conversationId:'welcome',messageId:'mobile-file',content:'',attachments:[file]};
 expect((await call(operation)).status).toBe(401);
 expect((await call({...operation,hostId:'other'},grant.token)).status).toBe(400);
 expect((await call({...operation,conversationId:'missing'},grant.token)).status).toBe(400);
 expect((await call({...operation,attachments:Array(7).fill(file)},grant.token)).status).toBe(400);
 expect((await call({...operation,attachments:[{...file,dataUrl:'data:text/plain;base64,eA=='}]},grant.token)).status).toBe(400);
 const oversized={...file,dataUrl:'data:application/octet-stream;base64,'+Buffer.alloc(8*1024*1024+1).toString('base64')};
 expect((await call({...operation,attachments:[oversized]},grant.token)).status).toBe(400);
 expect((await call({...operation,attachments:[oversized,oversized,oversized]},grant.token)).status).toBe(413);
 expect((await call(operation,grant.token)).status).toBe(200);
 const retry=await call(operation,grant.token); expect(retry.status).toBe(200);
 const snapshot=await retry.json();
 const messages=snapshot.conversations.find((c:{id:string})=>c.id==='welcome').messages.filter((m:{id:string})=>m.id==='mobile-file');
 expect(messages).toHaveLength(1); expect(messages[0].attachments).toEqual([file]);
 expect((await call({...operation,attachments:[{...file,name:'changed'}]},grant.token)).status).toBe(400);
 await fixture.owner('/mobile/revoke',{id:grant.sessionId});
 expect((await call({...operation,messageId:'after-revoke'},grant.token)).status).toBe(401);
});
