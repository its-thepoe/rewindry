import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from './store.ts';
import { safePreviewFile } from './preview-files.ts';
import { captureCheckpoint } from './capture.ts';

const PREVIEW_PATH = '/__rewindry/preview';
const ITERATIONS_PATH = '/__rewindry/iterations';
const IMAGE_PREFIX = '/__rewindry/image/';
const ASSET_PATHS = new Map([
  ['/__rewindry/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
  ['/__rewindry/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
]);
const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;

function localRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  const host = request.headers.host;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
      !host || !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}

type Next = (error?: unknown) => void;

interface PreviewServer {
  config?: { root: string };
  httpServer?: Server | null;
  waitForRequestsIdle?: () => Promise<void>;
  middlewares: {
    use(path: string, handler: (request: IncomingMessage, response: ServerResponse, next: Next) => void): void;
  };
  watcher: {
    on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): unknown;
  };
}

export interface PreviewIdentity {
  appId: string;
  serverId: string;
  generation: number;
  readiness: 'unverified' | 'idle';
}

export function rewindryPreviewPlugin(appId: string) {
  if (!appId.trim()) throw new Error('Rewindry preview requires an appId');

  const identity: PreviewIdentity = {
    appId,
    serverId: randomUUID(),
    generation: 0,
    readiness: 'unverified',
  };

  return {
    name: 'rewindry-preview-proof',
    apply: 'serve' as const,
    configureServer(server: PreviewServer) {
      const root = resolve(server.config?.root ?? process.cwd());
      const publishPreview = () => {
        if (!existsSync(join(root, '.rewindry'))) return;
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string') return;
        const configPath = join(root, '.rewindry', 'config.json');
        try {
          const previous = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> : {};
          const priorPreview = typeof previous.preview === 'object' && previous.preview !== null
            ? previous.preview as Record<string, unknown> : {};
          const previewUrl = `http://127.0.0.1:${address.port}/`;
          const config = {
            ...previous,
            preview: { ...priorPreview, url: previewUrl, appId },
          };
          const temporary = join(root, '.rewindry', `.config.${randomUUID()}.tmp`);
          writeFileSync(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
          renameSync(temporary, configPath);
          void retryLatestSourceOnly(previewUrl).catch((error: unknown) => {
            console.warn(`Rewindry preview retry failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        } catch (error) {
          console.warn(`Rewindry preview registration failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      let store: WorkspaceStore | undefined;
      const history = () => {
        if (!existsSync(join(root, '.rewindry', 'index.sqlite'))) return [];
        if (!store) {
          store = new WorkspaceStore(root);
          store.initialize();
        }
        return store.list();
      };
      const retryLatestSourceOnly = async (previewUrl: string) => {
        const checkpoint = history().at(-1);
        if (!checkpoint || !store) return;
        const recordPath = safePreviewFile(root, checkpoint.id, 'primary.json');
        if (!recordPath) return;
        const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { status?: unknown; attempts?: unknown };
        if (record.status !== 'source_only' || (typeof record.attempts === 'number' && record.attempts >= 2)) return;
        if (store.currentDigest() !== checkpoint.digest) return;
        await server.waitForRequestsIdle?.();
        await captureCheckpoint(root, store, checkpoint, { previewUrl, appId, retrySourceOnly: true });
      };
      server.httpServer?.once('listening', publishPreview);
      if (server.httpServer?.listening) publishPreview();
      const respond = (response: ServerResponse, status: number, type: string, body: string | Buffer) => {
        response.statusCode = status;
        response.setHeader('Content-Type', type);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(body);
      };
      const increment = (path: string) => {
        if (!path) return;
        const absolute = isAbsolute(path) ? path : resolve(root, path);
        const rel = relative(root, absolute);
        if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
        if (rel.split(sep).some((part) => ['.rewindry', '.git', 'node_modules', 'dist', 'build', 'coverage'].includes(part))) return;
        identity.generation += 1;
      };
      server.watcher.on('add', increment);
      server.watcher.on('change', increment);
      server.watcher.on('unlink', increment);

      server.middlewares.use(PREVIEW_PATH, (request, response, next) => {
        if (request.method !== 'GET' || request.url !== '/') {
          next();
          return;
        }
        if (!localRequest(request)) return respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
        const finish = () => respond(response, 200, 'application/json; charset=utf-8', JSON.stringify(identity));
        if (!server.waitForRequestsIdle) return finish();
        void server.waitForRequestsIdle().then(() => {
          identity.readiness = 'idle';
          finish();
        }).catch(() => {
          identity.readiness = 'unverified';
          finish();
        });
      });
      server.middlewares.use(ITERATIONS_PATH, (request, response, next) => {
        if (request.method !== 'GET' || request.url !== '/') return next();
        if (!localRequest(request)) return respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
        try {
          const checkpoints = history().map((checkpoint) => {
            const recordPath = safePreviewFile(root, checkpoint.id, 'primary.json');
            let previewStatus = 'source_only';
            if (recordPath) {
              try {
                const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { status?: unknown };
                if (record.status === 'captured' && safePreviewFile(root, checkpoint.id, 'primary.png')) {
                  previewStatus = 'captured';
                }
              } catch { /* A partial record remains source-only until published. */ }
            }
            return {
              id: checkpoint.id,
              createdAt: checkpoint.createdAt,
              ...(checkpoint.overlap ? { overlap: true } : {}),
              previewStatus,
              ...(previewStatus === 'captured' ? { previewUrl: `${IMAGE_PREFIX}${checkpoint.id}.png` } : {}),
            };
          });
          respond(response, 200, 'application/json; charset=utf-8', JSON.stringify({ checkpoints }));
        } catch {
          respond(response, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'History unavailable' }));
        }
      });
      server.middlewares.use(IMAGE_PREFIX, (request, response, next) => {
        if (request.method !== 'GET') return next();
        if (!localRequest(request)) return respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
        const match = /^([a-f0-9-]{36})\.png$/.exec(request.url?.slice(1) ?? '');
        if (!match || !CHECKPOINT_ID.test(match[1])) return next();
        const checkpointId = match[1];
        try {
          if (!history().some((checkpoint) => checkpoint.id === checkpointId)) return next();
          const recordPath = safePreviewFile(root, checkpointId, 'primary.json');
          if (!recordPath) return next();
          const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { status?: unknown };
          if (record.status !== 'captured') return next();
          const imagePath = safePreviewFile(root, checkpointId, 'primary.png');
          if (!imagePath) return next();
          respond(response, 200, 'image/png', readFileSync(imagePath));
        } catch {
          respond(response, 503, 'text/plain; charset=utf-8', 'Image unavailable');
        }
      });
      for (const [path, [name, type]] of ASSET_PATHS) {
        server.middlewares.use(path, (request, response, next) => {
          if (request.method !== 'GET' || request.url !== '/') return next();
          if (!localRequest(request)) return respond(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
          try {
            respond(response, 200, type, readFileSync(join(dirname(fileURLToPath(import.meta.url)), name)));
          } catch {
            respond(response, 503, 'text/plain; charset=utf-8', 'Overlay unavailable');
          }
        });
      }
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: '/__rewindry/overlay.js', defer: true, 'data-rewindry-preview': '' }, injectTo: 'body' as const }];
    },
  };
}
