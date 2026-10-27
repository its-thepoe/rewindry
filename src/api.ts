import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTwoFilesPatch } from 'diff';
import type { Checkpoint, WorkspaceStore } from './store.ts';
import { previewTargetRecords, type PreviewRecord } from './capture.ts';
import { readGitHistory } from './git-history.ts';
import { safePreviewFile } from './preview-files.ts';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;
const VISUAL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export class ViewerServer {
  private server?: Server;
  private eventTimer?: NodeJS.Timeout;
  private readonly eventClients = new Set<ServerResponse>();
  private eventSignature = '';
  private readonly token = randomBytes(32).toString('hex');
  private port = 0;
  private readonly viewerDir = join(dirname(fileURLToPath(import.meta.url)), 'viewer');

  constructor(
    private readonly root: string,
    private readonly store: WorkspaceStore,
    private readonly liveUrl?: string,
  ) {
    if (liveUrl) {
      const parsed = new URL(liveUrl);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
        throw new Error('Live preview must be local HTTP');
      }
    }
  }

  async start(): Promise<string> {
    if (this.server) throw new Error('Viewer already started');
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Viewer port unavailable');
    this.port = address.port;
    this.eventSignature = this.historySignature();
    this.eventTimer = setInterval(() => this.broadcastChanges(), 2_000);
    return `http://127.0.0.1:${this.port}/unlock/${this.token}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = undefined;
    for (const client of this.eventClients) client.end();
    this.eventClients.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const origin = `http://127.0.0.1:${this.port}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const frameOrigin = this.liveUrl ? `; frame-src ${new URL(this.liveUrl).origin}` : '';
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'${frameOrigin}`);
    if (request.method !== 'GET') return this.respond(response, 405, 'Method not allowed');
    if (request.headers.host !== `127.0.0.1:${this.port}` ||
        (request.headers.origin && request.headers.origin !== origin)) {
      return this.respond(response, 403, 'Forbidden origin');
    }
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname === `/unlock/${this.token}`) {
      response.statusCode = 302;
      response.setHeader('Set-Cookie', `rewindry=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
      response.setHeader('Location', '/');
      response.end();
      return;
    }
    if (!this.authorized(request)) return this.respond(response, 401, 'Viewer authorization required');
    try {
      if (url.pathname === '/') return this.asset(response, 'index.html', 'text/html; charset=utf-8');
      if (url.pathname === '/viewer.css') return this.asset(response, 'viewer.css', 'text/css; charset=utf-8');
      if (url.pathname === '/viewer.js') return this.asset(response, 'viewer.js', 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/events') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Connection', 'keep-alive');
        response.write('retry: 2000\n: connected\n\n');
        this.eventClients.add(response);
        response.once('close', () => this.eventClients.delete(response));
        return;
      }
      if (url.pathname === '/api/checkpoints') {
        const checkpoints = this.store.list().map((checkpoint) => {
          const preview = this.preview(checkpoint.id);
          return {
            id: checkpoint.id,
            kind: checkpoint.kind,
            ...(checkpoint.overlap ? { overlap: true } : {}),
            createdAt: checkpoint.createdAt,
            previewStatus: preview?.status ?? 'source_only',
            ...(preview?.status === 'captured' && safePreviewFile(this.root, checkpoint.id, 'primary.png')
              ? { previewUrl: `/api/previews/${checkpoint.id}/primary.png` } : {}),
            targets: preview ? previewTargetRecords(preview).map((target) => ({
              ...target,
              ...(target.status === 'captured' && VISUAL_ID.test(target.targetId) && VISUAL_ID.test(target.viewportId) && target.imageFile &&
                (target.imageFile === 'primary.png' || target.imageFile === `${target.targetId}--${target.viewportId}.png`) &&
                safePreviewFile(this.root, checkpoint.id, target.imageFile)
                ? { imageUrl: `/api/previews/${checkpoint.id}/${encodeURIComponent(target.targetId)}/${encodeURIComponent(target.viewportId)}.png` }
                : {}),
            })) : [],
          };
        });
        return this.json(response, { checkpoints, live: { label: 'Current working state', ...(this.liveUrl ? { url: this.liveUrl } : {}) } });
      }
      if (url.pathname === '/api/git') return this.json(response, readGitHistory(this.root));
      const filesMatch = /^\/api\/checkpoints\/([^/]+)\/files$/.exec(url.pathname);
      if (filesMatch) {
        const checkpoint = this.checkpoint(filesMatch[1]!);
        return this.json(response, { files: checkpoint.files });
      }
      const fileMatch = /^\/api\/checkpoints\/([^/]+)\/(file|diff)$/.exec(url.pathname);
      if (fileMatch) {
        const id = fileMatch[1]!;
        const path = url.searchParams.get('path') ?? '';
        const current = this.store.readFile(id, path);
        if (current.length > MAX_FILE_BYTES || current.includes(0)) return this.respond(response, 415, 'Binary or oversized file');
        if (fileMatch[2] === 'file') return this.respond(response, 200, current, 'text/plain; charset=utf-8');
        const checkpoints = this.store.list();
        const index = checkpoints.findIndex((item) => item.id === id);
        if (index < 0) return this.respond(response, 404, 'Checkpoint not found');
        let previous = '';
        if (index > 0) {
          if (checkpoints[index - 1]!.files.some((file) => file.path === path)) {
            const previousBytes = this.store.readFile(checkpoints[index - 1]!.id, path);
            if (previousBytes.length > MAX_FILE_BYTES || previousBytes.includes(0)) {
              return this.respond(response, 415, 'Binary or oversized previous file');
            }
            previous = previousBytes.toString('utf8');
          }
        }
        const diff = createTwoFilesPatch(path, path, previous, current.toString('utf8'), '', '', { context: 3 });
        return this.respond(response, 200, diff, 'text/plain; charset=utf-8');
      }
      const imageMatch = /^\/api\/previews\/([^/]+)\/primary\.png$/.exec(url.pathname);
      if (imageMatch) {
        const id = imageMatch[1]!;
        if (!CHECKPOINT_ID.test(id) || !this.store.list().some((checkpoint) => checkpoint.id === id) || this.preview(id)?.status !== 'captured') {
          return this.respond(response, 404, 'Preview unavailable');
        }
        const path = safePreviewFile(this.root, id, 'primary.png');
        if (!path) return this.respond(response, 404, 'Preview unavailable');
        return this.respond(response, 200, readFileSync(path), 'image/png');
      }
      const targetImageMatch = /^\/api\/previews\/([^/]+)\/([a-z0-9][a-z0-9-]{0,47})\/([a-z0-9][a-z0-9-]{0,47})\.png$/.exec(url.pathname);
      if (targetImageMatch) {
        const id = targetImageMatch[1]!;
        const targetId = targetImageMatch[2]!;
        const viewportId = targetImageMatch[3]!;
        if (!CHECKPOINT_ID.test(id) || !VISUAL_ID.test(targetId) || !VISUAL_ID.test(viewportId)) {
          return this.respond(response, 404, 'Preview unavailable');
        }
        const preview = this.store.list().some((checkpoint) => checkpoint.id === id) ? this.preview(id) : null;
        const target = preview ? previewTargetRecords(preview).find((item) => item.targetId === targetId && item.viewportId === viewportId) : undefined;
        const expected = `${targetId}--${viewportId}.png`;
        if (!target || target.status !== 'captured' || target.imageFile !== 'primary.png' && target.imageFile !== expected) {
          return this.respond(response, 404, 'Preview unavailable');
        }
        const path = safePreviewFile(this.root, id, target.imageFile);
        if (!path) return this.respond(response, 404, 'Preview unavailable');
        return this.respond(response, 200, readFileSync(path), 'image/png');
      }
      return this.respond(response, 404, 'Not found');
    } catch (error) {
      return this.respond(response, 404, error instanceof Error ? error.message : 'Unavailable');
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const value = /(?:^|;\s*)rewindry=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (!value || value.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(this.token));
  }

  private checkpoint(id: string): Checkpoint {
    if (!CHECKPOINT_ID.test(id)) throw new Error('Invalid checkpoint ID');
    const checkpoint = this.store.list().find((item) => item.id === id);
    if (!checkpoint) throw new Error('Checkpoint not found');
    return checkpoint;
  }

  private preview(id: string): PreviewRecord | null {
    if (!CHECKPOINT_ID.test(id)) return null;
    const path = safePreviewFile(this.root, id, 'primary.json');
    if (!path) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')) as PreviewRecord; }
    catch { return null; }
  }

  private historySignature(): string {
    return this.store.list().map((checkpoint) => `${checkpoint.id}:${this.preview(checkpoint.id)?.status ?? 'source_only'}`).join('|');
  }

  private broadcastChanges(): void {
    if (!this.eventClients.size) return;
    try {
      const signature = this.historySignature();
      if (signature === this.eventSignature) return;
      this.eventSignature = signature;
      for (const client of this.eventClients) client.write('event: refresh\ndata: {}\n\n');
    } catch {
      for (const client of this.eventClients) client.write('event: unavailable\ndata: {}\n\n');
    }
  }

  private asset(response: ServerResponse, name: string, type: string): void {
    const path = join(this.viewerDir, name);
    if (!existsSync(path)) return this.respond(response, 404, 'Viewer asset unavailable');
    this.respond(response, 200, readFileSync(path), type);
  }

  private json(response: ServerResponse, value: unknown): void {
    this.respond(response, 200, JSON.stringify(value), 'application/json; charset=utf-8');
  }

  private respond(response: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
    response.statusCode = status;
    response.setHeader('Content-Type', type);
    response.end(body);
  }
}
