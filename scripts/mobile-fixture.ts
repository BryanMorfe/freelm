/** Isolated integration fixture: actual StateStore, BotHost and InstanceHost, synthetic provider only. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BotHost } from '../electron/bot-host';
import { InstanceHost } from '../electron/instance-host';
import { StateStore } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { initialState } from '../src/lib/state';

export async function mobileFixture(options: { beforeIdentity?: () => Promise<void> } = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'freelm-mobile-'));
    const state = initialState();
    state.connections[0].id = 'synthetic'; state.activeConnectionId = 'synthetic';
    state.connections[0].apiKey = 'synthetic-never-sent';
    state.connections[0].catalog = [{ id: 'fixture', name: 'Synthetic provider', enabled: true, tasks: ['chat'], inputModalities: ['text'], outputModalities: ['text'], thinkingModes: [{id:'low',name:'Low',parameters:{responses:{reasoning:{effort:'low'}}}}] }];
    const store = new StateStore(path.join(directory, 'workspace.json'), {
        available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString(),
    });
    await store.save(state); const authority = new WorkspaceAuthority(store);
    const bots = new BotHost({ filename: path.join(directory, 'mailbox.json'),
        identity: async () => { await options.beforeIdentity?.(); return { id: 'synthetic-mac', name: 'Studio Mac · Test' }; },
        workspace: () => authority.loadBotState(),
        request: async () => {
            await new Promise(resolve => setTimeout(resolve, 800));
            return { status: 200, contentType: 'application/json', encoding: 'text', body: JSON.stringify({status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Your message reached the real FreeLM Bots host. This reply uses the isolated test provider; no model service was called.'}]}]}) };
        },
    });
    await bots.command({type:'create-bot',id:'sage',profile:{name:'Sage',identity:'A helpful test companion.',connectionId:'synthetic',model:'fixture',thinkingMode:'low',memoryEnabled:false,personalityLearning:false,historyAccess:false}});
    await bots.command({type:'create-conversation',id:'welcome',title:'Sage',participants:[{hostId:'synthetic-mac',botId:'sage'}]});
    await bots.command({type:'send',conversationId:'welcome',messageId:'existing-message',content:'Let’s pick up this conversation on my phone.'});
    const token = randomBytes(32).toString('base64url');
    const host = new InstanceHost({instanceId:'synthetic-mac',name:'Studio Mac · Test',port:0,token,authority,bots});
    const port = await host.start(); const endpoint = `http://127.0.0.1:${port}`;
    const owner = async (route: string, body = {}) => fetch(endpoint + route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const invite = async () => ({...await (await owner('/mobile/invitations')).json(),endpoint});
    return { directory, endpoint, invite, owner, bots, authority, close: async () => {await bots.close(); await host.stop();} };
}
if (process.argv.includes('--serve')) {
    const fixture = await mobileFixture();
    const invitationFile = path.join(fixture.directory,'invitation.json');
    const writeInvitation = async () => writeFile(invitationFile,JSON.stringify(await fixture.invite()),{mode:0o600});
    await writeInvitation();
    // SIGUSR1 refreshes a test-only invitation, never an owner profile.
    process.on('SIGUSR1',() => {void writeInvitation();});
    process.on('SIGTERM',() => {void fixture.close().then(() => process.exit(0));});
    console.log(JSON.stringify({pid:process.pid,endpoint:fixture.endpoint,invitationFile}));
}
