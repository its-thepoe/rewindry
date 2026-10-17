import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureCheckpoint } from '../src/capture.ts';
import { WorkspaceStore } from '../src/store.ts';

test('capture stores evidence for stable local preview and rejects source races', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-capture-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'one');
  const store = new WorkspaceStore(root);
  store.initialize();
  const first = store.snapshot('baseline');
  assert.ok(first);
  let generation = 1;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ appId: 'fixture', serverId: 'server-1', generation, readiness: 'unverified' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previewUrl = `http://127.0.0.1:${address.port}/`;
  try {
    const recorded = await captureCheckpoint(root, store, first, {
      previewUrl, appId: 'fixture', capturePage: async () => Buffer.from('fake-png'),
    });
    assert.equal(recorded.status, 'captured');
    assert.equal(recorded.serverId, 'server-1');
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', first.id, 'primary.png')).toString(), 'fake-png');
    assert.equal((await captureCheckpoint(root, store, first, {
      previewUrl, appId: 'fixture', capturePage: async () => { throw new Error('should not recapture'); },
    })).status, 'captured');

    writeFileSync(join(root, 'src', 'app.ts'), 'two');
    const second = store.snapshot('agent_turn', 'turn-2');
    assert.ok(second);
    const moved = await captureCheckpoint(root, store, second, {
      previewUrl, appId: 'fixture', capturePage: async () => {
        writeFileSync(join(root, 'src', 'app.ts'), 'three');
        return Buffer.from('wrong-state');
      },
    });
    assert.equal(moved.status, 'source_only');
    assert.match(moved.reason ?? '', /Source moved/);
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', second.id, 'primary.json'), 'utf8').includes('source_only'), true);
    generation++;
    const third = store.snapshot('agent_turn', 'turn-3');
    assert.ok(third);
    const stale = await captureCheckpoint(root, store, third, {
      previewUrl, appId: 'fixture', capturePage: async () => {
        generation++;
        return Buffer.from('stale');
      },
    });
    assert.equal(stale.status, 'source_only');
    assert.match(stale.reason ?? '', /generation changed/);

    writeFileSync(join(root, 'src', 'app.ts'), 'four');
    const fourth = store.snapshot('agent_turn', 'turn-4');
    assert.ok(fourth);
    const oversized = await captureCheckpoint(root, store, fourth, {
      previewUrl, appId: 'fixture', capturePage: async () => Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 'source_only');
    assert.equal(oversized.attempts, 1);
    assert.match(oversized.reason ?? '', /4 MiB image limit/);
    assert.equal(existsSync(join(root, '.rewindry', 'previews', fourth.id, 'primary.png')), false);
    assert.equal(store.readFile(fourth.id, 'src/app.ts').toString(), 'four');
    const recovered = await captureCheckpoint(root, store, fourth, {
      previewUrl, appId: 'fixture', retrySourceOnly: true,
      capturePage: async () => Buffer.from('recovered-png'),
    });
    assert.equal(recovered.status, 'captured');
    assert.equal(recovered.attempts, 2);
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', fourth.id, 'primary.png')).toString(), 'recovered-png');
    const stillFailed = await captureCheckpoint(root, store, third, {
      previewUrl, appId: 'fixture', retrySourceOnly: true,
      capturePage: async () => { throw new Error('should not reach browser after source moved'); },
    });
    assert.equal(stillFailed.status, 'source_only');
    assert.equal(stillFailed.attempts, 2);
    const exhausted = await captureCheckpoint(root, store, third, {
      previewUrl, appId: 'fixture', retrySourceOnly: true,
      capturePage: async () => { throw new Error('retry budget exceeded'); },
    });
    assert.equal(exhausted.attempts, 2);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy capture defaults to the root desktop viewport and primary.png', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-legacy-default-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'legacy default');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const server = createServer((_request, response) => response.end(JSON.stringify({
    appId: 'fixture', serverId: 'legacy-default', generation: 0, readiness: 'idle',
  })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let capturedUrl = '';
  let capturedRequest: unknown;
  try {
    const record = await captureCheckpoint(root, store, checkpoint, {
      previewUrl: `http://127.0.0.1:${address.port}/`,
      appId: 'fixture',
      capturePage: async (url, request) => {
        capturedUrl = url;
        capturedRequest = request;
        return Buffer.from('legacy-png');
      },
    });
    const previewDirectory = join(root, '.rewindry', 'previews', checkpoint.id);
    const metadata = JSON.parse(readFileSync(join(previewDirectory, 'primary.json'), 'utf8'));

    assert.equal(new URL(capturedUrl).pathname, '/');
    assert.deepEqual(capturedRequest, {
      viewport: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    });
    assert.equal(record.status, 'captured');
    assert.equal(record.route, '/');
    assert.deepEqual(record.viewport, { width: 1280, height: 800 });
    assert.deepEqual(record.targets, [{
      targetId: 'default',
      targetLabel: 'Page',
      viewportId: 'desktop',
      viewportLabel: 'Desktop',
      route: '/',
      viewport: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
      status: 'captured',
      imageFile: 'primary.png',
    }]);
    assert.equal(record.primaryTargetId, 'default');
    assert.equal(record.primaryViewportId, 'desktop');
    assert.equal(metadata.status, 'captured');
    assert.equal(metadata.route, '/');
    assert.deepEqual(metadata.viewport, { width: 1280, height: 800 });
    assert.deepEqual(metadata.targets, record.targets);
    assert.equal(metadata.primaryTargetId, 'default');
    assert.equal(metadata.primaryViewportId, 'desktop');
    assert.equal(readFileSync(join(previewDirectory, 'primary.png')).toString(), 'legacy-png');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture accepts an IPv6 loopback preview URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-capture-ipv6-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'ipv6');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ appId: 'fixture', serverId: 'ipv6-server', generation: 0, readiness: 'idle' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const captured = await captureCheckpoint(root, store, checkpoint, {
      previewUrl: `http://[::1]:${address.port}/`,
      appId: 'fixture',
      capturePage: async (url) => {
        assert.equal(new URL(url).hostname, '[::1]');
        return Buffer.from('ipv6-png');
      },
    });
    assert.equal(captured.status, 'captured');
    assert.equal(captured.serverId, 'ipv6-server');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('named captures persist each viewport, device profile, selector and independent result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-targets-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'targets');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const server = createServer((_request, response) => response.end(JSON.stringify({
    appId: 'fixture', serverId: 'target-server', generation: 0, readiness: 'idle',
  })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const calls: Array<{ url: string; request: { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number; selector?: string } }> = [];
  try {
    const record = await captureCheckpoint(root, store, checkpoint, {
      previewUrl: `http://127.0.0.1:${address.port}/`,
      appId: 'fixture',
      targets: [
        { id: 'bingo-home', label: 'Bingo home', route: '/', viewports: [
          { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
          { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
        ] },
        { id: 'bingo-board', label: 'Bingo board', route: '/?screen=board', selector: '[data-rewindry-target="bingo-board"]', viewports: [
          { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
          { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
        ] },
      ],
      capturePage: async (url, request) => {
        calls.push({ url, request });
        if (request.selector && request.viewport.width === 1280) throw new Error('selector unavailable');
        return Buffer.from(`png-${calls.length}`);
      },
    });
    assert.equal(record.status, 'captured');
    assert.deepEqual(calls.map(({ url }) => new URL(url).pathname + new URL(url).search), ['/', '/', '/?screen=board', '/?screen=board']);
    assert.deepEqual(calls[0]?.request, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    assert.equal(calls[2]?.request.selector, '[data-rewindry-target="bingo-board"]');
    assert.equal(record.primaryTargetId, 'bingo-home');
    assert.equal(record.primaryViewportId, 'mobile');
    assert.deepEqual(record.targets?.map((target) => [target.targetId, target.viewportId, target.status, target.imageFile]), [
      ['bingo-home', 'mobile', 'captured', 'primary.png'],
      ['bingo-home', 'desktop', 'captured', 'bingo-home--desktop.png'],
      ['bingo-board', 'mobile', 'captured', 'bingo-board--mobile.png'],
      ['bingo-board', 'desktop', 'source_only', undefined],
    ]);
    assert.match(record.targets?.[3]?.reason ?? '', /selector unavailable/);
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, 'primary.png')).toString(), 'png-1');
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, 'bingo-home--desktop.png')).toString(), 'png-2');
    assert.equal(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, 'bingo-board--mobile.png')).toString(), 'png-3');
    assert.equal(existsSync(join(root, '.rewindry', 'previews', checkpoint.id, 'bingo-board--desktop.png')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid target configuration remains source-only before attempting capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-invalid-targets-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'initial');
  const store = new WorkspaceStore(root);
  store.initialize();
  const server = createServer((_request, response) => response.end(JSON.stringify({
    appId: 'fixture', serverId: 'validation-server', generation: 0, readiness: 'idle',
  })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const validTarget = { id: 'home', label: 'Home', route: '/', viewports: [{ id: 'mobile', label: 'Mobile', width: 390, height: 844 }] };
  const tooMany = Array.from({ length: 13 }, (_, index) => ({
    id: `viewport-${index}`, label: `Viewport ${index}`, width: 390, height: 844,
  }));
  const invalidCases: Array<{ name: string; targets: unknown; reason: RegExp }> = [
    { name: 'unsafe target id', targets: [{ ...validTarget, id: '../home' }], reason: /target ID/ },
    { name: 'duplicate target id', targets: [validTarget, { ...validTarget, route: '/other' }], reason: /Duplicate preview target ID/ },
    { name: 'duplicate viewport id', targets: [{ ...validTarget, viewports: [validTarget.viewports[0], validTarget.viewports[0]] }], reason: /Duplicate viewport ID/ },
    { name: 'duplicate image filename', targets: [
      { ...validTarget, id: 'a--b', viewports: [{ id: 'c', label: 'C', width: 390, height: 844 }] },
      { ...validTarget, id: 'a', viewports: [{ id: 'b--c', label: 'B C', width: 390, height: 844 }] },
    ], reason: /duplicate image filename/ },
    { name: 'invalid viewport bounds', targets: [{ ...validTarget, viewports: [{ ...validTarget.viewports[0], width: 4097 }] }], reason: /viewport width/ },
    { name: 'external route', targets: [{ ...validTarget, route: 'https://example.com/' }], reason: /Preview must be a local HTTP URL/ },
    { name: 'variant cap', targets: [{ ...validTarget, viewports: tooMany }], reason: /12-variant limit/ },
    { name: 'control character label', targets: [{ ...validTarget, label: 'Home\n' }], reason: /printable characters/ },
    { name: 'control character selector', targets: [{ ...validTarget, selector: 'main\n', viewports: validTarget.viewports }], reason: /CSS selector/ },
  ];
  let captureCalled = false;
  try {
    for (const invalid of invalidCases) {
      writeFileSync(join(root, 'src', 'app.ts'), invalid.name);
      const checkpoint = store.snapshot('unattributed_group');
      assert.ok(checkpoint);
      const record = await captureCheckpoint(root, store, checkpoint, {
        previewUrl: `http://127.0.0.1:${address.port}/`,
        appId: 'fixture',
        targets: invalid.targets,
        capturePage: async () => { captureCalled = true; return Buffer.from('should not capture'); },
      });
      assert.equal(record.status, 'source_only', invalid.name);
      assert.match(record.reason ?? '', invalid.reason, invalid.name);
    }
    assert.equal(captureCalled, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('the workspace image quota counts non-primary variant PNGs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-variant-quota-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'quota');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const previews = join(root, '.rewindry', 'previews');
  mkdirSync(previews, { recursive: true });
  const existing = join(previews, 'older-checkpoint');
  mkdirSync(existing);
  const variant = join(existing, 'page--mobile.png');
  writeFileSync(variant, Buffer.alloc(0));
  truncateSync(variant, 256 * 1024 * 1024);
  const server = createServer((_request, response) => response.end(JSON.stringify({
    appId: 'fixture', serverId: 'quota-server', generation: 0, readiness: 'idle',
  })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const record = await captureCheckpoint(root, store, checkpoint, {
      previewUrl: `http://127.0.0.1:${address.port}/`, appId: 'fixture',
      capturePage: async () => Buffer.from('new image'),
    });
    assert.equal(record.status, 'source_only');
    assert.match(record.reason ?? '', /256 MiB image budget/);
    assert.equal(existsSync(join(previews, checkpoint.id, 'primary.png')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a generation race after one variant discards the whole visual set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-variant-race-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'race');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  let generation = 0;
  const server = createServer((_request, response) => response.end(JSON.stringify({
    appId: 'fixture', serverId: 'race-server', generation, readiness: 'idle',
  })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let calls = 0;
  try {
    const record = await captureCheckpoint(root, store, checkpoint, {
      previewUrl: `http://127.0.0.1:${address.port}/`, appId: 'fixture',
      targets: [{ id: 'page', label: 'Page', route: '/', viewports: [
        { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
        { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
      ] }],
      capturePage: async () => {
        calls++;
        if (calls === 2) generation++;
        return Buffer.from(`variant-${calls}`);
      },
    });
    assert.equal(calls, 2);
    assert.equal(record.status, 'source_only');
    assert.match(record.reason ?? '', /generation changed/);
    assert.ok(record.targets?.every((target) => target.status === 'source_only' && !target.imageFile));
    assert.equal(existsSync(join(root, '.rewindry', 'previews', checkpoint.id, 'primary.png')), false);
    assert.equal(existsSync(join(root, '.rewindry', 'previews', checkpoint.id, 'page--desktop.png')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
