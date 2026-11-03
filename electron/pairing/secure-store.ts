import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** One protected record. Implementations must provide atomic compare-and-replace. */
export interface PairingSecureStore {
  readonly scope: string;
  read(): Promise<string | null>;
  create(value: string): Promise<void>;
  replace(expected: string, value: string): Promise<void>;
}

/** No shell, plaintext backup, automatic initialization or storage fallback. */
export class NativePairingSecureStore implements PairingSecureStore {
  readonly scope: string;
  constructor(
    private readonly executable: string,
    private readonly isolatedKeychain?: string,
  ) {
    if (isolatedKeychain !== undefined) {
      if (!isolatedKeychain) throw new Error('Empty isolated Keychain path');
      this.isolatedKeychain = realpathSync(isolatedKeychain);
    }
    this.scope = this.isolatedKeychain ?? 'freelm-production-pairing';
  }
  private call(input: object): Promise<{ value?: string; missing?: boolean }> {
    return new Promise((resolve, reject) => {
      const args = this.isolatedKeychain ? ['--isolated-keychain', this.isolatedKeychain] : [];
      const child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let overflow = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Pairing secure storage timed out'));
      }, 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 262144) {
          overflow = true;
          child.kill();
        }
      });
      // Never propagate native output: it may contain a protected record.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Pairing secure storage unavailable'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (overflow || code !== 0 || result.error) throw new Error();
          resolve(result);
        } catch {
          reject(new Error('Pairing secure storage operation failed'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }
  async read() {
    const result = await this.call({ operation: 'read' });
    if (result.missing) return null;
    if (typeof result.value !== 'string') throw new Error('Invalid secure storage response');
    return result.value;
  }
  async create(value: string) {
    await this.call({ operation: 'create', value });
  }
  async replace(expected: string, value: string) {
    await this.call({ operation: 'replace', expected, value });
  }
}
