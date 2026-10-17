import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { rewindryPreviewPlugin } from '../src/vite-plugin.ts';
import { WorkspaceStore } from '../src/store.ts';

test('preview plugin is serve-only and injects one trigger', () => {
  const plugin = rewindryPreviewPlugin('fixture');
  assert.equal(plugin.apply, 'serve');
  const tags = plugin.transformIndexHtml();
  assert.equal(tags.length, 1);
  assert.equal(tags[0]?.attrs['data-rewindry-preview'], '');
  assert.equal(tags[0]?.attrs.src, '/__rewindry/overlay.js');
  assert.throws(() => rewindryPreviewPlugin('  '), /appId/);
});

test('preview registration uses a loopback address matching Vite IPv4 and IPv6 bindings', () => {
  for (const address of [
    { address: '127.0.0.1', expectedHost: '127.0.0.1' },
    { address: '::1', expectedHost: '[::1]' },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'rewindry-preview-host-'));
    try {
      mkdirSync(join(root, '.rewindry'));
      const httpServer = Object.assign(new EventEmitter(), {
        listening: false,
        address: () => ({ address: address.address, family: address.address.includes(':') ? 'IPv6' : 'IPv4', port: 3100 }),
      });
      const plugin = rewindryPreviewPlugin('fixture');
      plugin.configureServer({
        config: { root },
        httpServer: httpServer as unknown as import('node:http').Server,
        watcher: new EventEmitter(),
        middlewares: { use() {} },
      });
      httpServer.emit('listening');
      const config = JSON.parse(readFileSync(join(root, '.rewindry', 'config.json'), 'utf8')) as {
        preview: { url: string };
      };
      assert.equal(config.preview.url, `http://${address.expectedHost}:3100/`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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

test('Vite preview publishes named target metadata and serves only registered safe images', () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-vite-targets-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'vite target');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const previewDirectory = join(root, '.rewindry', 'previews', checkpoint.id);
  mkdirSync(previewDirectory, { recursive: true });
  writeFileSync(join(previewDirectory, 'primary.png'), 'primary');
  writeFileSync(join(previewDirectory, 'home--desktop.png'), 'desktop');
  const record = {
    status: 'captured', route: '/', viewport: { width: 390, height: 844 },
    targets: [
      { targetId: 'home', targetLabel: 'Home', viewportId: 'mobile', viewportLabel: 'Mobile', route: '/', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, status: 'captured', imageFile: 'primary.png' },
      { targetId: 'home', targetLabel: 'Home', viewportId: 'desktop', viewportLabel: 'Desktop', route: '/', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, status: 'captured', imageFile: 'home--desktop.png' },
      { targetId: 'board', targetLabel: 'Board', viewportId: 'mobile', viewportLabel: 'Mobile', route: '/', selector: '[data-board]', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, status: 'source_only', reason: 'selector missing' },
    ],
  };
  writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify(record));
  const handlers = new Map<string, (request: IncomingMessage, response: ServerResponse, next: () => void) => void>();
  const plugin = rewindryPreviewPlugin('fixture');
  plugin.configureServer({
    config: { root },
    watcher: new EventEmitter(),
    middlewares: { use(path, callback) { handlers.set(path, callback); } },
  });
  const read = (middleware: string, url: string, address = '127.0.0.1', origin?: string) => {
    let body: string | Buffer = '';
    let statusCode = 200;
    let nextCalled = false;
    handlers.get(middleware)?.(
      { method: 'GET', url, socket: { remoteAddress: address }, headers: { host: '127.0.0.1:5173', ...(origin ? { origin } : {}) } } as unknown as IncomingMessage,
      { setHeader() {}, get statusCode() { return statusCode; }, set statusCode(value: number) { statusCode = value; }, end(value: string | Buffer) { body = value; } } as unknown as ServerResponse,
      () => { nextCalled = true; },
    );
    return { statusCode, body: body.toString(), nextCalled };
  };
  try {
    const iterations = read('/__rewindry/iterations', '/');
    assert.equal(iterations.statusCode, 200);
    const result = JSON.parse(iterations.body) as { checkpoints: Array<{ id: string; targets: Array<{ targetId: string; viewportId: string; imageUrl?: string }> }> };
    assert.equal(result.checkpoints[0]?.targets.length, 3);
    assert.equal(result.checkpoints[0]?.targets[1]?.imageUrl, `/__rewindry/image/${checkpoint.id}/home/desktop.png`);
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/desktop.png`).body, 'desktop');
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/mobile.png`).body, 'primary');
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/board/mobile.png`).nextCalled, true);
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home%2F..%2Fdesktop.png`).nextCalled, true);
    assert.equal(read('/__rewindry/image/', '/ffffffff-ffff-4fff-8fff-ffffffffffff/home/desktop.png').nextCalled, true);
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/desktop.png`, '192.168.1.5').statusCode, 403);
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/desktop.png`, '127.0.0.1', 'http://evil.local').statusCode, 403);

    writeFileSync(join(root, 'src', 'app.ts'), 'legacy');
    const legacy = store.snapshot('unattributed_group');
    assert.ok(legacy);
    const legacyDirectory = join(root, '.rewindry', 'previews', legacy.id);
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, 'primary.json'), JSON.stringify({ status: 'captured', route: '/legacy', viewport: { width: 800, height: 600 } }));
    writeFileSync(join(legacyDirectory, 'primary.png'), 'legacy');
    const legacyList = JSON.parse(read('/__rewindry/iterations', '/').body) as { checkpoints: Array<{ id: string; targets: Array<{ targetId: string; route: string; imageUrl?: string }> }> };
    const legacyEntry = legacyList.checkpoints.find((item) => item.id === legacy.id)!;
    assert.deepEqual([legacyEntry.targets[0]?.targetId, legacyEntry.targets[0]?.route], ['default', '/legacy']);
    assert.equal(legacyEntry.targets[0]?.imageUrl, `/__rewindry/image/${legacy.id}/default/desktop.png`);

    symlinkSync(join(root, 'src', 'app.ts'), join(previewDirectory, 'home--symlink.png'));
    writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify({
      ...record, targets: [{ ...record.targets[0], viewportId: 'symlink', imageFile: 'home--symlink.png' }],
    }));
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/symlink.png`).nextCalled, true);
    rmSync(join(previewDirectory, 'home--symlink.png'));
    writeFileSync(join(previewDirectory, 'home--large.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
    writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify({
      ...record, targets: [{ ...record.targets[0], viewportId: 'large', imageFile: 'home--large.png' }],
    }));
    assert.equal(read('/__rewindry/image/', `/${checkpoint.id}/home/large.png`).nextCalled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
