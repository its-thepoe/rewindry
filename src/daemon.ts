import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RewindryRuntime } from './runtime.ts';
import type { AgentEvent } from './turn-manager.ts';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 32;

export type DaemonStatus = {
  workspaceId: string;
  root: string;
  pid: number;
  startedAt: string;
  sourceCapture: 'active' | 'degraded' | 'paused_storage_full';
  agentBoundaryCapture: 'unverified';
  visualCapture: 'configured_unverified' | 'unavailable';
  checkpointCount: number;
  sourceStorageBytes: number;
  sourceBudgetBytes: number;
  observedWrites: number;
  diagnostics: string[];
};

type Request = { action: 'status'; workspaceId?: string } | { action: 'event'; event: AgentEvent };
type Response = { ok: true; status?: DaemonStatus; accepted?: boolean } | { ok: false; error: string };

export function userDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Rewindry');
}

export function daemonSocketPath(dataDir = userDataDir()): string {
  const fallback = join(dataDir, 'daemon.sock');
  const metadata = join(dataDir, 'daemon.json');
  if (!existsSync(metadata)) return fallback;
  try {
    const value = JSON.parse(readFileSync(metadata, 'utf8')) as { socketPath?: unknown };
    if (typeof value.socketPath !== 'string' || dirname(resolve(value.socketPath)) !== resolve(dataDir)) return fallback;
    return value.socketPath;
  } catch { return fallback; }
}

export function previewConfigured(root: string): boolean {
  const path = join(root, '.rewindry', 'config.json');
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as { preview?: { url?: unknown; appId?: unknown } };
    if (typeof config.preview?.url !== 'string' || typeof config.preview.appId !== 'string' || !config.preview.appId) return false;
    const url = new URL(config.preview.url);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export class LocalDaemon {
  readonly runtime: RewindryRuntime;
  readonly socketPath: string;
  private readonly dataDir: string;
  private readonly root: string;
  private readonly runtimes = new Map<string, { root: string; runtime: RewindryRuntime }>();
  private readonly instanceId = randomUUID();
  private server?: Server;
  private socketIdentity?: { dev: number; ino: number };
  private startedAt = '';

  constructor(root: string, options: { dataDir?: string; runtime?: RewindryRuntime; workspaceRoots?: string[] } = {}) {
    this.root = realpathSync(root);
    this.runtime = options.runtime ?? new RewindryRuntime(root);
    for (const workspaceRoot of options.workspaceRoots ?? [root]) {
      const canonicalRoot = realpathSync(workspaceRoot);
      const runtime = canonicalRoot === this.root ? this.runtime : new RewindryRuntime(canonicalRoot);
      this.runtimes.set(runtime.workspaceId, { root: canonicalRoot, runtime });
    }
    if (!this.runtimes.has(this.runtime.workspaceId)) {
      this.runtimes.set(this.runtime.workspaceId, { root: this.root, runtime: this.runtime });
    }
    this.dataDir = options.dataDir ?? userDataDir();
    this.socketPath = join(this.dataDir, `d-${this.instanceId.slice(0, 6)}.sock`);
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Daemon already started');
    if (Buffer.byteLength(this.socketPath) >= 104) {
      throw new Error('Daemon socket path is too long for macOS; choose a shorter --data-dir');
    }
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    const activeSocketPath = daemonSocketPath(this.dataDir);
    if (existsSync(activeSocketPath)) {
      if (!lstatSync(activeSocketPath).isSocket()) throw new Error('Daemon socket path is occupied');
      const active = await queryDaemon(activeSocketPath, { action: 'status' }, 150).catch(() => null);
      if (active?.ok) throw new Error('Daemon is already running');
      unlinkSync(activeSocketPath);
    }
    const started: RewindryRuntime[] = [];
    try {
      for (const { runtime } of this.runtimes.values()) {
        await runtime.start();
        started.push(runtime);
      }
    } catch (error) {
      await Promise.allSettled(started.map((runtime) => runtime.close()));
      throw error;
    }
    const server = createServer((socket) => this.handleConnection(socket));
    server.maxConnections = MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
      });
      chmodSync(this.socketPath, 0o600);
      const socketStat = lstatSync(this.socketPath);
      this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
      this.server = server;
      this.startedAt = new Date().toISOString();
      const metadata = {
        schemaVersion: 1, socketPath: this.socketPath, pid: process.pid,
        startedAt: this.startedAt, workspaceId: this.runtime.workspaceId, instanceId: this.instanceId,
        workspaceIds: [...this.runtimes.keys()],
      };
      const target = join(this.dataDir, 'daemon.json');
      const temp = join(this.dataDir, `.daemon.${randomUUID()}.tmp`);
      writeFileSync(temp, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      renameSync(temp, target);
      chmodSync(target, 0o600);
    } catch (error) {
      server.close();
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      await Promise.allSettled([...this.runtimes.values()].map(({ runtime }) => runtime.close()));
      throw error;
    }
  }

  status(workspaceId = this.runtime.workspaceId): DaemonStatus {
    const workspace = this.runtimes.get(workspaceId);
    if (!workspace) throw new Error('Workspace is not registered with this daemon');
    const { root, runtime } = workspace;
    const diagnostics = [...runtime.observer.diagnostics, ...runtime.turns.diagnostics];
    const storageFull = runtime.turns.captureFailure === 'storage_full' ||
      runtime.turns.captureFailure === 'source_budget_exceeded';
    const degraded = runtime.turns.captureFailure === 'snapshot_error' ||
      runtime.observer.diagnostics.some((entry) => entry.startsWith('watcher_error:') || entry.startsWith('rescan_error:'));
    return {
      workspaceId: runtime.workspaceId,
      root,
      pid: process.pid,
      startedAt: this.startedAt,
      sourceCapture: storageFull ? 'paused_storage_full' : degraded ? 'degraded' : 'active',
      agentBoundaryCapture: 'unverified',
      visualCapture: previewConfigured(root) ? 'configured_unverified' : 'unavailable',
      checkpointCount: runtime.store.list().length,
      sourceStorageBytes: runtime.store.sourceStorageBytes(),
      sourceBudgetBytes: runtime.store.sourceBudgetBytes(),
      observedWrites: runtime.observedWrites,
      diagnostics,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const metadata = join(this.dataDir, 'daemon.json');
    if (server && existsSync(metadata)) {
      try {
        const value = JSON.parse(readFileSync(metadata, 'utf8')) as { pid?: number; instanceId?: string };
        const ownsRegistration = value.pid === process.pid && value.instanceId === this.instanceId;
        if (ownsRegistration && this.socketIdentity && existsSync(this.socketPath)) {
          const current = lstatSync(this.socketPath);
          if (current.isSocket() && current.dev === this.socketIdentity.dev && current.ino === this.socketIdentity.ino) {
            unlinkSync(this.socketPath);
          }
        }
        if (ownsRegistration) unlinkSync(metadata);
      } catch { /* Leave unreadable registration for diagnosis. */ }
    }
    await Promise.allSettled([...this.runtimes.values()].map(({ runtime }) => runtime.close()));
  }

  private handleConnection(socket: Socket): void {
    let input = '';
    let inputBytes = 0;
    // A timed-out local client may close before this response is written.
    socket.on('error', () => {});
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      inputBytes += chunk.length;
      if (inputBytes > MAX_MESSAGE_BYTES) {
        socket.end(JSON.stringify({ ok: false, error: 'Message too large' }) + '\n');
        return;
      }
      input += chunk.toString('utf8');
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      let response: Response;
      try {
        const request = JSON.parse(line) as Request;
        if (request.action === 'status') response = { ok: true, status: this.status(request.workspaceId) };
        else if (request.action === 'event') {
          const runtime = this.runtimes.get(request.event.workspaceId)?.runtime;
          if (!runtime) throw new Error('Workspace is not registered with this daemon');
          response = { ok: true, accepted: runtime.ingest(request.event) };
        }
        else response = { ok: false, error: 'Unknown action' };
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : 'Invalid request' };
      }
      socket.end(JSON.stringify(response) + '\n');
    });
  }
}

export function queryDaemon(socketPath: string, request: Request, timeoutMs = 500): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => socket.destroy(new Error('Daemon timed out')), timeoutMs);
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) socket.destroy(new Error('Response too large'));
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timeout);
        socket.end();
        try { resolve(JSON.parse(buffer.slice(0, newline)) as Response); }
        catch (error) { reject(error); }
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('Daemon closed without a response'));
    });
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
  });
}

export async function sendHookEvent(socketPath: string, event: AgentEvent, timeoutMs = 150): Promise<boolean> {
  try {
    const response = await queryDaemon(socketPath, { action: 'event', event }, timeoutMs);
    return response.ok && response.accepted === true;
  } catch {
    return false;
  }
}
