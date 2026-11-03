/** Isolated integration fixture: actual StateStore, BotHost and InstanceHost, synthetic provider only. */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { BotHost } from '../electron/bot-host';
import { InstanceHost } from '../electron/instance-host';
import { StateStore } from '../electron/state-store';
import { WorkspaceAuthority } from '../electron/workspace-authority';
import { initialState } from '../src/lib/state';

export async function mobileTLSFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'freelm-mobile-tls-'));
  const state = initialState();
  state.connections[0].id = 'synthetic';
  state.activeConnectionId = 'synthetic';
  state.connections[0].apiKey = 'synthetic-never-sent';
  state.connections[0].catalog = [
    {
      id: 'fixture',
      name: 'Synthetic provider',
      enabled: true,
      tasks: ['chat'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      thinkingModes: [
        { id: 'low', name: 'Low', parameters: { responses: { reasoning: { effort: 'low' } } } },
      ],
    },
  ];
  const store = new StateStore(path.join(directory, 'workspace.json'), {
    available: () => true,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  await store.save(state);
  const authority = new WorkspaceAuthority(store);
  const bots = new BotHost({
    filename: path.join(directory, 'mailbox.json'),
    identity: async () => ({ id: 'synthetic-mac', name: 'Studio Mac · Test' }),
    workspace: () => authority.loadBotState(),
    request: async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return {
        status: 200,
        contentType: 'application/json',
        encoding: 'text',
        body: JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Your message reached the real FreeLM Bots host. This reply uses the isolated test provider; no model service was called.',
                },
              ],
            },
          ],
        }),
      };
    },
  });
  await bots.command({
    type: 'create-bot',
    id: 'sage',
    profile: {
      name: 'Sage',
      identity: 'A helpful test companion.',
      connectionId: 'synthetic',
      model: 'fixture',
      thinkingMode: 'low',
      memoryEnabled: false,
      personalityLearning: false,
      historyAccess: false,
    },
  });
  await bots.command({
    type: 'create-conversation',
    id: 'welcome',
    title: 'Sage',
    participants: [{ hostId: 'synthetic-mac', botId: 'sage' }],
  });
  await bots.command({
    type: 'send',
    conversationId: 'welcome',
    messageId: 'existing-message',
    content: 'Let’s pick up this conversation on my phone.',
  });
  const token = randomBytes(32).toString('base64url');
  const host = new InstanceHost({
    instanceId: 'synthetic-mac',
    name: 'Studio Mac · Test',
    port: 0,
    token,
    authority,
    bots,
  });
  try {
    const file = (name: string) => path.join(directory, name);
    const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('ca.key'),
      '-out',
      file('ca.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=FreeLM Disposable Simulator CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    );
    openssl(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('server.key'),
      '-out',
      file('server.csr'),
      '-subj',
      '/CN=localhost',
    );
    await writeFile(
      file('extensions.cnf'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    );
    openssl(
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file('server.pem'),
      '-days',
      '1',
      '-sha256',
      '-extfile',
      file('extensions.cnf'),
    );
    const caDERFile = file('ca.der');
    openssl('x509', '-in', file('ca.pem'), '-outform', 'DER', '-out', caDERFile);
    const port = await new Promise<number>((resolve, reject) => {
      const reservation = createServer();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const port = (reservation.address() as { port: number }).port;
        reservation.close(() => resolve(port));
      });
    });
    const endpoint = `https://localhost:${port}`;
    await host.startMobile({
      cert: await readFile(file('server.pem'), 'utf8'),
      key: await readFile(file('server.key'), 'utf8'),
      endpoint,
      bindAddress: '127.0.0.1',
    });
    const invite = () => host.inviteMobile();
    return {
      directory,
      endpoint,
      caDERFile,
      host,
      invite,
      bots,
      authority,
      close: async () => {
        await host.stop();
        await bots.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host.stop();
    await bots.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv.includes('--serve')) {
  const fixture = await mobileTLSFixture();
  const invitationFile = path.join(fixture.directory, 'invitation.json');
  const writeInvitation = async () => {
    const pending = fixture.host.mobileStatus().invitation;
    if (pending) fixture.host.revokeMobile(pending.id);
    await writeFile(invitationFile, JSON.stringify(fixture.invite()), { mode: 0o600 });
  };
  await writeInvitation();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGUSR1', () => {
    void writeInvitation().catch((error) => console.error(error.message));
  });
  process.on('SIGTERM', () => {
    void close();
  });
  process.on('SIGINT', () => {
    void close();
  });
  // Test-only process cannot remain listening indefinitely.
  setTimeout(() => {
    void close();
  }, 20 * 60_000).unref();
  console.log(
    JSON.stringify({
      pid: process.pid,
      endpoint: fixture.endpoint,
      invitationFile,
      caDERFile: fixture.caDERFile,
      expiresInMinutes: 20,
    }),
  );
}
