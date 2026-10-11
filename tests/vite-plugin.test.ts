import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { rewindryPreviewPlugin } from '../src/vite-plugin.ts';

test('preview plugin is serve-only and injects one trigger', () => {
  const plugin = rewindryPreviewPlugin('fixture');
  assert.equal(plugin.apply, 'serve');
  const tags = plugin.transformIndexHtml();
  assert.equal(tags.length, 1);
  assert.equal(tags[0]?.attrs['data-rewindry-preview'], '');
  assert.equal(tags[0]?.attrs.src, '/__rewindry/overlay.js');
  assert.throws(() => rewindryPreviewPlugin('  '), /appId/);
});

test('preview identity is stable per server and generation increases on observed writes', () => {
  const plugin = rewindryPreviewPlugin('fixture');
  const watcher = new EventEmitter();
  const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse, next: () => void) => void>();
  plugin.configureServer({
    config: { root: '/fixture' },
    watcher,
    middlewares: { use(path, callback) { handlers.set(path, callback); } },
  });
  assert.ok(handlers.has('/__rewindry/preview'));

  const read = (path: string, address = '127.0.0.1', origin?: string) => {
    let body = '';
    let statusCode = 200;
    handlers.get(path)?.(
      { method: 'GET', url: '/', socket: { remoteAddress: address }, headers: { host: '127.0.0.1:5173', ...(origin ? { origin } : {}) } } as unknown as IncomingMessage,
      { setHeader() {}, get statusCode() { return statusCode; }, set statusCode(value: number) { statusCode = value; }, end(value: string) { body = value; } } as unknown as ServerResponse,
      () => assert.fail('GET should be handled'),
    );
    return { statusCode, body };
  };

  const first = JSON.parse(read('/__rewindry/preview').body) as { appId: string; serverId: string; generation: number; readiness: string };
  watcher.emit('change', '/fixture/src/app.tsx');
  watcher.emit('add', '/fixture/public/logo.svg');
  watcher.emit('unlink', '/fixture/index.html');
  watcher.emit('change', '/fixture/.rewindry/previews/image.png');
  watcher.emit('change', '/fixture/node_modules/.vite/deps.js');
  const second = JSON.parse(read('/__rewindry/preview').body) as typeof first;
  assert.equal(first.appId, 'fixture');
  assert.equal(first.generation, 0);
  assert.equal(second.generation, 3);
  assert.equal(second.serverId, first.serverId);
  assert.equal(second.readiness, 'unverified');
  assert.deepEqual(JSON.parse(read('/__rewindry/iterations').body), { checkpoints: [] });
  assert.equal(read('/__rewindry/iterations', '192.168.1.24').statusCode, 403);
  assert.equal(read('/__rewindry/iterations', '127.0.0.1', 'http://evil.local:3000').statusCode, 403);
});
