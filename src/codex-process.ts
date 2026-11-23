import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

export type Fields = Record<string, unknown>;

export function object(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

export function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class CodexError extends Error {}

// Use the npm shim's native payload. Node and PowerShell are not needed at run time.
export async function findCodex(): Promise<string | null> {
  const paths = (process.env.Path ?? process.env.PATH ?? '').split(delimiter);
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) {
    paths.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    paths.push(join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'));
  }
  if (process.env.USERPROFILE) paths.push(join(process.env.USERPROFILE, '.local', 'bin'));
  const platform = 'codex-win32-x64', triple = 'x86_64-pc-windows-msvc';
  for (const raw of new Set(paths)) {
    const dir = raw.replace(/^"|"$/g, '');
    if (!isAbsolute(dir)) continue;
    const candidates = [join(dir, 'codex.exe')];
    if (await exists(join(dir, 'codex.cmd'))) {
      const npm = join(dir, 'node_modules', '@openai');
      for (const parent of [join(npm, 'codex', 'node_modules', '@openai'), npm]) {
        candidates.push(join(parent, platform, 'vendor', triple, 'bin', 'codex.exe'));
      }
      candidates.push(join(npm, 'codex', 'vendor', triple, 'bin', 'codex.exe'));
    }
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function withEmptyDirectory<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'opensosen-fingerprint-'));
  try {
    return await work(cwd);
  } finally {
    await rmdir(cwd).catch(() => {});
  }
}

export function savedLoginEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.create(inherited) as NodeJS.ProcessEnv;
  // Exec accepts environment-auth overrides that stdio app-server does not.
  // Shadow only their names, without accessing the values or changing the parent.
  const overrides = new Set(['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']);
  for (const name of Object.keys(inherited)) {
    if (overrides.has(name.toUpperCase())) Object.defineProperty(env, name, { value: undefined });
  }
  return env;
}

export function launch(executable: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(executable, args, { cwd, env: savedLoginEnvironment(process.env), windowsHide: true, stdio: 'pipe' });
  // Codex owns its credentials. Protocol and stderr records never reach app logs.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  return child;
}

export async function bundledModels(executable: string, cwd: string, signal: AbortSignal) {
  try {
    const { stdout } = await promisify(execFile)(executable, ['debug', 'models', '--bundled'], {
      cwd, signal, windowsHide: true, env: savedLoginEnvironment(process.env), timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    });
    const models = new Map<string, Fields>();
    for (const entry of array(object(JSON.parse(stdout)).models).map(object)) {
      const id = string(entry.slug);
      if (id) models.set(id, entry);
    }
    if (models.size) return models;
  } catch {
    signal.throwIfAborted();
  }
  throw new CodexError('无法读取 Codex 内置模型目录。请更新官方 Windows Codex CLI 后刷新。');
}

export function messages(child: ChildProcessWithoutNullStreams, callback: (msg: Fields) => void) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // This stream can contain non-protocol startup notices.
      return;
    }
    callback(object(message));
  });
  return lines;
}

type Pending = { resolve: (value: Fields) => void; reject: (reason: CodexError) => void };

export class AppServer {
  #child: ChildProcessWithoutNullStreams;
  #requests = new Map<number, Pending>();
  #closed: Promise<void>;
  #nextId = 0;
  #exited = false;

  constructor(executable: string, cwd: string, config: Fields) {
    const child = this.#child = launch(executable, ['app-server', '--stdio', ...overrides(config)], cwd);
    messages(child, (msg) => {
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        this.#send({ id: msg.id, error: { code: -32601, message: 'This client only reads metadata.' } });
        return;
      }
      if (typeof msg.id !== 'number') return;
      const request = this.#requests.get(msg.id);
      if (msg.error) {
        const code = object(msg.error).code;
        request?.reject(new CodexError(`本机 Codex 接口错误（RPC ${typeof code === 'number' ? code : '未知'}）。`));
      } else request?.resolve(object(msg.result));
    });
    this.#closed = new Promise((resolve) => child.once('close', () => {
      this.#exited = true;
      this.#fail('Codex app-server 已退出。请确认官方 CLI 可在此账号下运行。');
      resolve();
    }));
    child.once('error', () => this.#fail('无法启动 Codex app-server。'));
  }

  #fail(reason: string) {
    for (const pending of this.#requests.values()) pending.reject(new CodexError(reason));
  }

  #send(message: Fields) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method: string, params: Fields, signal: AbortSignal, timeout = 15_000): Promise<Fields> {
    signal.throwIfAborted();
    if (this.#exited) throw new CodexError('Codex app-server 已退出。');
    const id = ++this.#nextId;
    const result = new Promise<Fields>((resolve, reject) => this.#requests.set(id, { resolve, reject }));
    const abort = () => this.#requests.get(id)?.reject(new CodexError('已取消 Codex 连接检查。'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.#requests.get(id)?.reject(new CodexError(`Codex ${method} 超时。`)), timeout);
    try {
      this.#send({ id, method, params });
      return await result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.#requests.delete(id);
    }
  }

  async initialize(signal: AbortSignal) {
    const hello = await this.request('initialize', {
      clientInfo: { name: 'opensosen_model_fingerprint', title: 'OpenSosen Model Fingerprint', version: '0.1.1' },
    }, signal);
    this.#send({ method: 'initialized' });
    return string(hello.userAgent)?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null;
  }

  async close() {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 800);
    await this.#closed;
    clearTimeout(timer);
  }
}

export function overrides(config: Fields): string[] {
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}
