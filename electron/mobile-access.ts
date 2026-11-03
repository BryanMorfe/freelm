import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Ephemeral, scoped grants. Restarting the host revokes every invitation and session. */
export class MobileAccess {
  private invitations = new Map<string, { hash: string; expiresAt: number }>();
  private sessions = new Map<string, { id: string; expiresAt: number }>();
  constructor(private readonly now = Date.now) {}
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  private prune() {
    for (const [id, value] of this.invitations)
      if (value.expiresAt <= this.now()) this.invitations.delete(id);
    for (const [id, value] of this.sessions)
      if (value.expiresAt <= this.now()) this.sessions.delete(id);
  }
  invite() {
    this.prune();
    if (this.invitations.size >= 1) throw new Error('Too many pending invitations.');
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url'),
      expiresAt = this.now() + 120_000;
    this.invitations.set(id, { hash: this.hash(secret), expiresAt });
    return { id, secret, expiresAt };
  }
  exchange(id: string, secret: string) {
    this.prune();
    const invite = this.invitations.get(id);
    if (!invite || this.hash(secret) !== invite.hash)
      throw new Error('Invitation expired or already used.');
    if (this.sessions.size >= 1)
      throw new Error('Too many paired clients. Revoke a session first.');
    this.invitations.delete(id); // Consume synchronously before any asynchronous work.
    const token = randomBytes(32).toString('base64url'),
      sessionId = randomUUID(),
      expiresAt = this.now() + 8 * 60 * 60_000;
    this.sessions.set(this.hash(token), { id: sessionId, expiresAt });
    return { token, sessionId, expiresAt };
  }
  authorize(token: string) {
    this.prune();
    return this.sessions.get(this.hash(token));
  }
  revoke(id: string) {
    this.invitations.delete(id);
    for (const [key, value] of this.sessions) if (value.id === id) this.sessions.delete(key);
  }
  status() {
    this.prune();
    return {
      sessions: [...this.sessions.values()].map((value) => ({ ...value })),
      invitation: [...this.invitations].map(([id, value]) => ({
        id,
        expiresAt: value.expiresAt,
      }))[0],
    };
  }
  clear() {
    this.invitations.clear();
    this.sessions.clear();
  }
}
