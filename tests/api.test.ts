import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ViewerServer } from '../src/api.ts';
import { WorkspaceStore } from '../src/store.ts';

test('viewer source API requires its own cookie and rejects preview origins and writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-api-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'old');
  const store = new WorkspaceStore(root);
  store.initialize();
  const before = store.snapshot('baseline');
  assert.ok(before);
  writeFileSync(join(root, 'src', 'app.ts'), 'new');
  const after = store.snapshot('agent_turn', 'turn-1');
  assert.ok(after);
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const base = new URL(unlockUrl).origin;
    const denied = await fetch(`${base}/api/checkpoints`);
    assert.equal(denied.status, 401);
    const unlock = await fetch(unlockUrl, { redirect: 'manual' });
    assert.equal(unlock.status, 302);
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie };
    const list = await fetch(`${base}/api/checkpoints`, { headers });
    assert.equal(list.status, 200);
    const data = await list.json() as { checkpoints: Array<{ id: string }>; live: { label: string } };
    assert.equal(data.checkpoints.length, 2);
    assert.equal(data.live.label, 'Current working state');
    const file = await fetch(`${base}/api/checkpoints/${after.id}/file?path=src%2Fapp.ts`, { headers });
    assert.equal(await file.text(), 'new');
    const diff = await fetch(`${base}/api/checkpoints/${after.id}/diff?path=src%2Fapp.ts`, { headers });
    assert.match(await diff.text(), /\+new/);
    const crossOrigin = await fetch(`${base}/api/checkpoints`, {
      headers: { ...headers, Origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(crossOrigin.status, 403);
    const mutation = await fetch(`${base}/api/checkpoints`, { method: 'POST', headers });
    assert.equal(mutation.status, 405);
    const traversal = await fetch(`${base}/api/checkpoints/${after.id}/file?path=..%2F.env`, { headers });
    assert.equal(traversal.status, 404);
    const previewDir = join(root, '.rewindry', 'previews', after.id);
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, 'primary.json'), JSON.stringify({ status: 'captured' }));
    symlinkSync(join(root, 'src', 'app.ts'), join(previewDir, 'primary.png'));
    const symlinkedImage = await fetch(`${base}/api/previews/${after.id}/primary.png`, { headers });
    assert.equal(symlinkedImage.status, 404);
    rmSync(join(previewDir, 'primary.png'));
    writeFileSync(join(previewDir, 'primary.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const oversizedImage = await fetch(`${base}/api/previews/${after.id}/primary.png`, { headers });
    assert.equal(oversizedImage.status, 404);
    writeFileSync(join(previewDir, 'primary.json'), Buffer.alloc(64 * 1024 + 1));
    const oversizedRecord = await fetch(`${base}/api/previews/${after.id}/primary.png`, { headers });
    assert.equal(oversizedRecord.status, 404);
    assert.equal(store.readFile(after.id, 'src/app.ts').toString(), 'new');
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff endpoint rejects an oversized previous file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-large-diff-'));
  mkdirSync(join(root, 'src'));
  const store = new WorkspaceStore(root);
  store.initialize();
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ capture: { maxFileBytes: 6 * 1024 * 1024 } }));
  store.initialize();
  writeFileSync(join(root, 'src', 'app.ts'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  store.snapshot('baseline');
  writeFileSync(join(root, 'src', 'app.ts'), 'small');
  const checkpoint = store.snapshot('agent_turn', 'turn');
  assert.ok(checkpoint);
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const base = new URL(unlockUrl).origin;
    const unlock = await fetch(unlockUrl, { redirect: 'manual' });
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const diff = await fetch(`${base}/api/checkpoints/${checkpoint.id}/diff?path=src%2Fapp.ts`, { headers: { Cookie: cookie } });
    assert.equal(diff.status, 415);
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('viewer SSE stream is authenticated and announces new checkpoints', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-events-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'first');
  const store = new WorkspaceStore(root);
  store.initialize();
  store.snapshot('baseline');
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const base = new URL(unlockUrl).origin;
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    const unlock = await fetch(unlockUrl, { redirect: 'manual' });
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    writeFileSync(join(root, 'src', 'app.ts'), 'second');
    store.snapshot('agent_turn', 'test-turn');
    const reader = events.body?.getReader();
    assert.ok(reader);
    let received = '';
    const deadline = Date.now() + 6_000;
    while (!received.includes('event: refresh') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    assert.match(received, /event: refresh/);
    controller.abort();
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated viewer publishes named captures, keeps legacy records readable and validates target images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-api-targets-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'visuals');
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const previewDirectory = join(root, '.rewindry', 'previews', checkpoint.id);
  mkdirSync(previewDirectory, { recursive: true });
  writeFileSync(join(previewDirectory, 'primary.png'), 'primary-image');
  writeFileSync(join(previewDirectory, 'home--desktop.png'), 'desktop-image');
  writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify({
    checkpointId: checkpoint.id,
    status: 'captured',
    sourceDigest: checkpoint.digest,
    appId: 'fixture',
    route: '/',
    viewport: { width: 390, height: 844 },
    fidelityLimits: [],
    primaryTargetId: 'home',
    primaryViewportId: 'mobile',
    targets: [
      { targetId: 'home', targetLabel: 'Bingo home', viewportId: 'mobile', viewportLabel: 'Mobile', route: '/', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, status: 'captured', imageFile: 'primary.png' },
      { targetId: 'home', targetLabel: 'Bingo home', viewportId: 'desktop', viewportLabel: 'Desktop', route: '/', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, status: 'captured', imageFile: 'home--desktop.png' },
      { targetId: 'board', targetLabel: 'Bingo board', viewportId: 'mobile', viewportLabel: 'Mobile', route: '/', selector: '[data-board]', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, status: 'source_only', reason: 'selector missing' },
    ],
  }));
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const base = new URL(unlockUrl).origin;
    const unlock = await fetch(unlockUrl, { redirect: 'manual' });
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie };
    const response = await fetch(`${base}/api/checkpoints`, { headers });
    const body = await response.json() as { checkpoints: Array<{ id: string; previewUrl?: string; targets: Array<{ targetId: string; viewportId: string; imageUrl?: string; status: string }> }> };
    const listed = body.checkpoints[0]!;
    assert.equal(listed.id, checkpoint.id);
    assert.equal(listed.targets.length, 3);
    assert.equal(listed.targets[0]?.imageUrl, `/api/previews/${checkpoint.id}/home/mobile.png`);
    assert.equal(listed.targets[1]?.imageUrl, `/api/previews/${checkpoint.id}/home/desktop.png`);
    assert.equal(listed.targets[2]?.status, 'source_only');
    const primary = await fetch(`${base}${listed.previewUrl}`, { headers });
    assert.equal(await primary.text(), 'primary-image');
    const desktop = await fetch(`${base}/api/previews/${checkpoint.id}/home/desktop.png`, { headers });
    assert.equal(await desktop.text(), 'desktop-image');
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/board/mobile.png`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/../home/desktop.png`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/previews/ffffffff-ffff-4fff-8fff-ffffffffffff/home/desktop.png`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/home/desktop.png`)).status, 401);
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/home/desktop.png`, { headers: { ...headers, Origin: 'http://127.0.0.1:5173' } })).status, 403);

    writeFileSync(join(root, 'src', 'app.ts'), 'legacy');
    const legacy = await store.snapshot('unattributed_group');
    assert.ok(legacy);
    const legacyDirectory = join(root, '.rewindry', 'previews', legacy.id);
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, 'primary.json'), JSON.stringify({ status: 'captured', route: '/old', viewport: { width: 800, height: 600 } }));
    writeFileSync(join(legacyDirectory, 'primary.png'), 'legacy-image');
    const refreshed = await (await fetch(`${base}/api/checkpoints`, { headers })).json() as { checkpoints: Array<{ id: string; targets: Array<{ targetId: string; route: string; viewport: { width: number; height: number }; imageUrl?: string }> }> };
    const fallback = refreshed.checkpoints.find((item) => item.id === legacy.id)!;
    assert.deepEqual([fallback.targets[0]?.targetId, fallback.targets[0]?.route, fallback.targets[0]?.viewport], ['default', '/old', { width: 800, height: 600 }]);
    assert.equal(fallback.targets[0]?.imageUrl, `/api/previews/${legacy.id}/default/desktop.png`);
    assert.equal(await (await fetch(`${base}${fallback.targets[0]!.imageUrl}`, { headers })).text(), 'legacy-image');

    symlinkSync(join(root, 'src', 'app.ts'), join(previewDirectory, 'home--symlink.png'));
    writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify({
      status: 'captured', route: '/', viewport: { width: 390, height: 844 },
      targets: [{ targetId: 'home', targetLabel: 'Bingo home', viewportId: 'symlink', viewportLabel: 'Symlink', route: '/', viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, status: 'captured', imageFile: 'home--symlink.png' }],
    }));
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/home/symlink.png`, { headers })).status, 404);
    rmSync(join(previewDirectory, 'home--symlink.png'));
    writeFileSync(join(previewDirectory, 'home--large.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
    writeFileSync(join(previewDirectory, 'primary.json'), JSON.stringify({
      status: 'captured', route: '/', viewport: { width: 390, height: 844 },
      targets: [{ targetId: 'home', targetLabel: 'Bingo home', viewportId: 'large', viewportLabel: 'Large', route: '/', viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, status: 'captured', imageFile: 'home--large.png' }],
    }));
    assert.equal((await fetch(`${base}/api/previews/${checkpoint.id}/home/large.png`, { headers })).status, 404);
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('viewer API labels replayed visuals and leaves live and legacy payloads unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-api-replay-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'live');
  const store = new WorkspaceStore(root);
  store.initialize();
  const live = store.snapshot('baseline');
  assert.ok(live);
  writeFileSync(join(root, 'src', 'app.ts'), 'replayed');
  const replayed = store.snapshot('unattributed_group');
  assert.ok(replayed);
  const target = (viewportId: string, imageFile: string, extra: Record<string, unknown> = {}) => ({
    targetId: 'home', targetLabel: 'Home', viewportId, viewportLabel: viewportId, route: '/', viewport: { width: 1280, height: 800 },
    isMobile: false, hasTouch: false, deviceScaleFactor: 1, status: 'captured', imageFile, ...extra,
  });
  const write = (id: string, targets: unknown[]) => {
    const directory = join(root, '.rewindry', 'previews', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'primary.png'), `${id}-primary`);
    writeFileSync(join(directory, 'home--mobile.png'), `${id}-mobile`);
    writeFileSync(join(directory, 'primary.json'), JSON.stringify({
      checkpointId: id, status: 'captured', sourceDigest: 'x', appId: 'fixture', route: '/', viewport: { width: 1280, height: 800 }, fidelityLimits: [], targets,
    }));
  };
  write(live.id, [target('desktop', 'primary.png'), target('mobile', 'home--mobile.png', { captureMode: 'replayed', replayedAt: '2026-10-27T00:00:00.000Z' })]);
  write(replayed.id, [target('desktop', 'primary.png', { captureMode: 'replayed', replayedAt: '2026-10-27T00:00:00.000Z' })]);
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const cookie = (await fetch(unlockUrl, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const body = await (await fetch(`${new URL(unlockUrl).origin}/api/checkpoints`, { headers: { Cookie: cookie } })).json() as {
      checkpoints: Array<{ id: string; previewUrl?: string; previewCaptureMode?: string; targets: Array<{ viewportId: string; captureMode?: string; replayedAt?: string; imageUrl?: string }> }>;
    };
    const liveEntry = body.checkpoints.find((item) => item.id === live.id)!;
    assert.ok(liveEntry.previewUrl);
    assert.equal('previewCaptureMode' in liveEntry, false);
    assert.equal(liveEntry.targets.find((item) => item.viewportId === 'desktop')?.captureMode, undefined);
    const replayedSibling = liveEntry.targets.find((item) => item.viewportId === 'mobile')!;
    assert.equal(replayedSibling.captureMode, 'replayed');
    assert.equal(replayedSibling.replayedAt, '2026-10-27T00:00:00.000Z');
    assert.ok(replayedSibling.imageUrl);
    const replayedEntry = body.checkpoints.find((item) => item.id === replayed.id)!;
    assert.equal(replayedEntry.previewCaptureMode, 'replayed');
    assert.equal(replayedEntry.targets[0]?.captureMode, 'replayed');
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
