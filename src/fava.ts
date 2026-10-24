/**
 * Fava, the Beancount web interface, run next to gram as a child process. It serves the
 * books gram exports (src/books.ts), read-only, on a Unix socket in a private directory;
 * the console reaches it only through gram's /fava/ proxy, behind the controller session.
 */
import { existsSync, lstatSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
export type FavaConfig = { python: string; socket: string; ledgers: string };
export type FavaState = 'starting' | 'running' | 'restarting' | 'stopped' | 'unavailable';

/** Where Fava is installed: FINANCE_WORLD_FAVA_PYTHON, else the venv `bun run fava:setup` makes. */
export function locateFava(env: Record<string, string | undefined> = process.env): { python?: string; reason?: string } {
  if (env.FINANCE_WORLD_FAVA === 'off') return { reason: 'Fava is switched off (FINANCE_WORLD_FAVA=off).' };
  const python = env.FINANCE_WORLD_FAVA_PYTHON || resolve(root, '.fava/venv/bin/python');
  if (!existsSync(python)) return { reason: `Fava is not installed. Run \`bun run fava:setup\` (looked for ${python}).` };
  return { python };
}

/** A Unix socket path short enough for sockaddr_un (104 bytes on macOS), in a directory only this user can enter. */
export function favaSocket(port: number | string, env: Record<string, string | undefined> = process.env) {
  if (env.FINANCE_WORLD_FAVA_SOCKET) return env.FINANCE_WORLD_FAVA_SOCKET;
  const uid = process.getuid?.() ?? 0, base = process.platform === 'win32' ? tmpdir() : '/tmp', dir = join(base, `gram-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== uid)) throw new Error(`${dir} is not a private directory owned by this user`);
  chmodSync(dir, 0o700);
  return join(dir, `fava-${port}.sock`);
}

export class FavaHost {
  readonly config: FavaConfig;
  state: FavaState = 'stopped';
  reason: string | undefined;
  private process: ReturnType<typeof Bun.spawn> | undefined;
  private stopping = false;
  private failures = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private log: (type: string, data: any) => void;
  private output = '';
  constructor(config: FavaConfig, log: (type: string, data: any) => void = () => {}) { this.config = config; this.log = log; }

  start() {
    if (this.process || this.stopping) return;
    this.state = this.failures ? 'restarting' : 'starting'; this.output = '';
    const child = Bun.spawn([this.config.python, '-I', resolve(import.meta.dir, 'fava_host.py'), '--socket', this.config.socket, '--ledgers', this.config.ledgers, '--trusted-host', 'localhost'], {
      // The host exits when this pipe closes, so it never outlives gram.
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
    });
    this.process = child;
    void this.collect(child.stdout as ReadableStream<Uint8Array>); void this.collect(child.stderr as ReadableStream<Uint8Array>);
    void child.exited.then(code => {
      if (this.process !== child) return;
      this.process = undefined;
      if (this.stopping) { this.state = 'stopped'; return; }
      this.failures++; this.state = 'restarting'; this.reason = `Fava exited with code ${code}: ${this.output.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`;
      this.log('fava.exited', { code, failures: this.failures, output: this.output.slice(-2000) });
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
      this.restartTimer = setTimeout(() => this.start(), delay); this.restartTimer.unref?.();
    });
  }

  private async collect(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder(), reader = stream.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const text = decoder.decode(next.value, { stream: true });
      if (text.includes('fava-host ready')) { this.state = 'running'; this.reason = undefined; this.failures = 0; this.log('fava.ready', { socket: this.config.socket, pid: this.process?.pid }); }
      this.output = (this.output + text).slice(-8000);
    }
  }

  /** Wait for the host to listen; true once it answers. */
  async ready(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === 'running') { try { if ((await this.request('/healthz')).ok) return true; } catch {} }
      if (this.stopping) return false;
      await Bun.sleep(100);
    }
    return false;
  }

  /** One request to the host over its socket. Fava builds its links from the path, so the host name is nominal. */
  request(path: string, init: RequestInit = {}) {
    return fetch('http://localhost' + path, { ...init, redirect: 'manual', unix: this.config.socket } as RequestInit);
  }

  status() { return { state: this.state, ...(this.reason ? { reason: this.reason } : {}), pid: this.process?.pid ?? null }; }

  async stop() {
    this.stopping = true; if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.process; if (!child) { this.state = 'stopped'; return; }
    try { (child.stdin as any)?.end?.(); } catch {}
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) { child.kill(); await child.exited; }
    this.process = undefined; this.state = 'stopped';
  }
}
