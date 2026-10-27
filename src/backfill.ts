import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureBackfillVariants, type BackfillCaptureOptions, type PreviewRecord } from './capture.ts';
import { WorkspaceStore, type Checkpoint } from './store.ts';

const BACKFILL_IDENTITY_PATH = '/__rewindry/backfill-preview';
const PRIVATE_COMPONENT = /(?:^\.env(?:\..*)?$|secret|credential|private[-_]?key)/i;
const FORBIDDEN_COMPONENTS = new Set(['.rewindry', '.git', 'node_modules', 'dist', 'build', 'coverage']);
const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;

export type BackfillIo = { out: (line: string) => void; error: (line: string) => void };
export type BackfillSummary = { captured: number; partial: number; unavailable: number; stopped?: string };
type SnapshotFile = { path: string; digest: string; size: number };
type ReplayServer = { previewUrl: string; close: () => Promise<void> };
export type BackfillServices = {
  startPreview?: (root: string, appId: string, checkpointId: string) => Promise<ReplayServer>;
  capture?: typeof captureBackfillVariants;
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function treeDigest(files: SnapshotFile[]): string {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256(JSON.stringify(sorted.map(({ path, digest, size }) => [path, digest, size])));
}

function validateRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || FORBIDDEN_COMPONENTS.has(part) || PRIVATE_COMPONENT.test(part))) {
    throw new Error(`Unsafe checkpoint path: ${path}`);
  }
}

function safeTemporaryParent(root: string): string {
  const storage = join(root, '.rewindry');
  if (!existsSync(storage) || !lstatSync(storage).isDirectory()) throw new Error('Rewindry storage is unavailable');
  const parent = join(storage, 'tmp');
  if (existsSync(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error('Backfill temporary path is not a regular directory');
  } else {
    mkdirSync(parent);
  }
  return parent;
}

function assertRegularDirectory(root: string, path: string): void {
  const relativePath = relative(root, path);
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe materialization directory: ${current}`);
  }
}

export function materializeCheckpointSnapshot(root: string, checkpoint: Checkpoint, store: WorkspaceStore): SnapshotFile[] {
  if (!CHECKPOINT_ID.test(checkpoint.id)) throw new Error('Invalid checkpoint ID');
  const files = checkpoint.files.map((file) => ({ path: file.path, digest: file.digest, size: file.size }));
  for (const file of files) validateRelativePath(file.path);
  if (treeDigest(files) !== checkpoint.digest) throw new Error(`Checkpoint manifest digest mismatch: ${checkpoint.id}`);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Duplicate checkpoint path: ${file.path}`);
    seen.add(file.path);
    const bytes = store.readFile(checkpoint.id, file.path);
    if (bytes.length !== file.size || sha256(bytes) !== file.digest) {
      throw new Error(`Checkpoint object digest mismatch: ${file.path}`);
    }
    const destination = join(root, ...file.path.split('/'));
    const parent = dirname(destination);
    assertRegularDirectory(root, parent);
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  return files;
}

function materializedDigest(root: string, files: SnapshotFile[]): string {
  const actual: SnapshotFile[] = [];
  for (const file of files) {
    const path = join(root, ...file.path.split('/'));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Materialized source changed: ${file.path}`);
    const bytes = readFileSync(path);
    actual.push({ path: file.path, digest: sha256(bytes), size: bytes.length });
  }
  return treeDigest(actual);
}

function appIdFor(root: string, config: { preview?: { appId?: unknown } }): string {
  if (typeof config.preview?.appId === 'string' && config.preview.appId.trim()) return config.preview.appId;
  return `rewindry-${sha256(root).slice(0, 12)}`;
}

function isLoopbackRequest(request: { socket: { remoteAddress?: string }; headers: { host?: string; origin?: string } }): boolean {
  const address = request.socket.remoteAddress;
  const host = request.headers.host;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
      !host || !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}

function backfillIdentityPlugin(appId: string) {
  const identity = { appId, serverId: randomUUID(), generation: 0, readiness: 'unverified' as 'idle' | 'unverified' };
  return {
    name: 'rewindry-historical-preview-proof',
    apply: 'serve' as const,
    configureServer(server: {
      config?: { root: string };
      waitForRequestsIdle?: () => Promise<void>;
      middlewares: { use(path: string, handler: (request: any, response: any, next: () => void) => void): void };
      watcher: { on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): unknown };
    }) {
      const root = resolve(server.config?.root ?? process.cwd());
      const respond = (response: any, status: number, body: string) => {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(body);
      };
      server.middlewares.use(BACKFILL_IDENTITY_PATH, (request, response, next) => {
        if (request.method !== 'GET' || request.url !== '/') return next();
        if (!isLoopbackRequest(request)) return respond(response, 403, JSON.stringify({ error: 'Forbidden' }));
        const finish = () => respond(response, 200, JSON.stringify(identity));
        if (!server.waitForRequestsIdle) return finish();
        void server.waitForRequestsIdle().then(() => {
          identity.readiness = 'idle';
          finish();
        }).catch(() => {
          identity.readiness = 'unverified';
          finish();
        });
      });
      const increment = (path: string) => {
        const absolute = isAbsolute(path) ? path : resolve(root, path);
        const rel = relative(root, absolute);
        if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) ||
            rel.split(sep).some((part) => FORBIDDEN_COMPONENTS.has(part))) return;
        identity.generation += 1;
      };
      server.watcher.on('add', increment);
      server.watcher.on('change', increment);
      server.watcher.on('unlink', increment);
    },
  };
}

async function startHistoricalPreview(activeRoot: string, root: string, appId: string): Promise<ReplayServer> {
  const nodeModules = join(activeRoot, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error('Current project node_modules are unavailable');
  const installedModules = realpathSync(nodeModules);
  if (!lstatSync(installedModules).isDirectory()) throw new Error('Current project node_modules are unavailable');
  const tempModules = join(root, 'node_modules');
  if (existsSync(tempModules)) throw new Error('Historical checkpoint unexpectedly contains node_modules');
  symlinkSync(installedModules, tempModules, 'dir');

  const require = createRequire(join(activeRoot, 'package.json'));
  const vitePath = require.resolve('vite');
  const vite = await import(pathToFileURL(vitePath).href) as {
    createServer(options: Record<string, unknown>): Promise<{
      config: { root: string; cacheDir: string; server: { host?: string | boolean; port: number; proxy?: unknown } };
      httpServer?: { address(): string | { address: string; port: number } | null };
      listen(): Promise<void>;
      close(): Promise<void>;
    }>;
  };
  const proofPlugin = backfillIdentityPlugin(appId);
  const server = await vite.createServer({
    root,
    configFile: undefined,
    cacheDir: join(root, '.rewindry-vite-cache'),
    plugins: [proofPlugin],
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, cors: false, proxy: {} },
  });
  try {
    if (resolve(server.config.root) !== resolve(root) || server.config.server.host !== '127.0.0.1' ||
        server.config.server.port !== 0 || resolve(server.config.cacheDir) !== resolve(root, '.rewindry-vite-cache') ||
        server.config.server.proxy && Object.keys(server.config.server.proxy as object).length) {
      throw new Error('Historical Vite config requested settings outside the isolated loopback preview');
    }
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      throw new Error('Historical Vite preview did not bind to loopback');
    }
    return { previewUrl: `http://127.0.0.1:${address.port}/`, close: () => server.close() };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

function currentPreviewConfig(root: string): { preview?: { appId?: unknown; targets?: unknown } } {
  const path = join(root, '.rewindry', 'config.json');
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile()) throw new Error('Invalid Rewindry config');
  return JSON.parse(readFileSync(path, 'utf8')) as { preview?: { appId?: unknown; targets?: unknown } };
}

function statusOf(record: PreviewRecord): 'captured' | 'partial' | 'unavailable' {
  const variants = record.targets ?? [];
  const captured = variants.filter((target) => target.status === 'captured').length;
  if (!captured) return 'unavailable';
  return captured === variants.length ? 'captured' : 'partial';
}

export async function runBackfill(
  root: string,
  io: BackfillIo,
  services: BackfillServices = {},
): Promise<BackfillSummary> {
  const canonicalRoot = realpathSync(root);
  const store = new WorkspaceStore(canonicalRoot);
  store.initialize();
  const config = currentPreviewConfig(canonicalRoot);
  const appId = appIdFor(canonicalRoot, config);
  const checkpoints = store.list();
  const summary: BackfillSummary = { captured: 0, partial: 0, unavailable: 0 };
  const capture = services.capture ?? captureBackfillVariants;

  for (let index = 0; index < checkpoints.length; index++) {
    const checkpoint = checkpoints[index]!;
    io.out(`Backfill ${index + 1}/${checkpoints.length}: ${checkpoint.id}`);
    let temporaryRoot: string | undefined;
    let replay: ReplayServer | undefined;
    let record: PreviewRecord | undefined;
    try {
      if (!checkpoint.files.length) {
        record = await capture(canonicalRoot, { currentDigest: () => checkpoint.digest }, checkpoint, {
          appId, targets: config.preview?.targets, unavailableReason: 'Checkpoint has no saved source files and cannot be replayed.',
        });
      } else {
        const tempParent = safeTemporaryParent(canonicalRoot);
        temporaryRoot = mkdtempSync(join(tempParent, `${checkpoint.id}-`));
        const files = materializeCheckpointSnapshot(temporaryRoot, checkpoint, store);
        const sourceStore = { currentDigest: () => materializedDigest(temporaryRoot!, files) };
        if (sourceStore.currentDigest() !== checkpoint.digest) throw new Error(`Checkpoint materialization digest mismatch: ${checkpoint.id}`);
        const startPreview = services.startPreview ?? ((snapshotRoot, previewAppId) =>
          startHistoricalPreview(canonicalRoot, snapshotRoot, previewAppId));
        try {
          replay = await startPreview(temporaryRoot, appId, checkpoint.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          record = await capture(canonicalRoot, sourceStore, checkpoint, {
            appId, targets: config.preview?.targets, unavailableReason: reason,
          });
        }
        if (replay) {
          record = await capture(canonicalRoot, sourceStore, checkpoint, {
            appId,
            previewUrl: replay.previewUrl,
            identityPath: BACKFILL_IDENTITY_PATH,
            targets: config.preview?.targets,
          });
        }
      }
      if (!record) throw new Error('Historical preview did not return a replay result');
      const status = statusOf(record);
      summary[status]++;
      io.out(`Backfill ${checkpoint.id}: ${status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Unsafe checkpoint path|manifest digest mismatch|object digest mismatch|materialization digest mismatch|Checkpoint object|Manifest corrupt|Object corrupt|File not present in checkpoint/i.test(message)) {
        summary.stopped = message;
        io.error(`Backfill stopped: ${message}`);
        break;
      }
      summary.unavailable++;
      io.error(`Backfill ${checkpoint.id}: unavailable (${message})`);
    } finally {
      await replay?.close().catch(() => {});
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  io.out(`Backfill complete: ${summary.captured} captured, ${summary.partial} partial, ${summary.unavailable} unavailable.`);
  return summary;
}

export function historicalViteConfig(root: string): string[] {
  const extensions = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'];
  return extensions.map((extension) => join(root, `vite.config${extension}`)).filter(existsSync);
}
