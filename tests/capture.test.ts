import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
