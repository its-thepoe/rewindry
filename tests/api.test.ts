import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('screen history API is authenticated, GET-only and serves only referenced visuals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-history-api-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'Dialog.tsx'), 'v1');
  const store = new WorkspaceStore(root);
  store.initialize();
  const first = store.snapshot('baseline');
  writeFileSync(join(root, 'src', 'Dialog.tsx'), 'v2');
  const second = store.snapshot('agent_turn', 'turn-1');
  assert.ok(first && second);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const dialog = store.upsertUiState({ origin: 'learned', route: '/?welcome=1', componentSet: hash('dialog'), components: ['src/Dialog.tsx#Dialog'],
    path: [{ action: 'click', target: [{ by: 'role', role: 'button', name: 'Close welcome', index: 0 }] }, { action: 'click', target: [{ by: 'css', value: 'main > button', index: 0 }, { by: 'role', role: 'button', name: 'Item 2', index: 0 }] }] });
  const frameA = store.writeVisual(Buffer.from('frame-a'));
  const frameB = store.writeVisual(Buffer.from('frame-b'));
  const cropA = store.writeVisual(Buffer.from('crop-a'));
  const cropB = store.writeVisual(Buffer.from('crop-b'));
  const stray = store.writeVisual(Buffer.from('not referenced'));
  const box = { x: 10, y: 20, width: 100, height: 50 };
  store.recordScreenFrame({ checkpointId: first.id, stateId: dialog.id, profileId: 'mobile', status: 'captured', captureMode: 'live', imageDigest: frameA,
    components: [{ componentKey: 'src/Dialog.tsx#Dialog', occurrence: 0, cropDigest: cropA, box }] });
  // A second copy of the dialog changes in the same iteration: counts are per iteration, not per copy.
  store.recordScreenFrame({ checkpointId: second.id, stateId: dialog.id, profileId: 'mobile', status: 'captured', captureMode: 'live', imageDigest: frameB,
    components: [{ componentKey: 'src/Dialog.tsx#Dialog', occurrence: 0, cropDigest: cropB, box }, { componentKey: 'src/Dialog.tsx#Dialog', occurrence: 1, cropDigest: cropA, box }] });
  store.recordScreenFrame({ checkpointId: second.id, stateId: dialog.id, profileId: 'desktop', status: 'path_broken', captureMode: 'live', reason: 'Step 2 of 2: no recorded locator matched' });
  const viewer = new ViewerServer(root, store);
  try {
    const unlockUrl = await viewer.start();
    const base = new URL(unlockUrl).origin;
    for (const path of ['/api/history', `/api/history/frames?state=${dialog.id}`, `/api/visuals/${frameA}.png`, '/history']) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
    const cookie = (await fetch(unlockUrl, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie };
    const get = (path: string) => fetch(`${base}${path}`, { headers });

    const page = await get('/history');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /history\.js/);
    assert.equal((await get('/history.js')).status, 200);

    const summary = await (await get('/api/history')).json() as {
      profiles: string[]; states: { id: string; label: string; steps: number; frames: number; changed: number; status: string }[];
      components: { key: string; file: string; component: string; changed: number; states: number }[];
    };
    assert.deepEqual(summary.profiles, ['desktop', 'mobile']);
    assert.deepEqual(summary.states, [{ id: dialog.id, route: '/?welcome=1', label: '/?welcome=1 · after “Item 2”', origin: 'learned', status: 'active', steps: 2, frames: 3, changed: 2 }]);
    assert.deepEqual(summary.components, [{ key: 'src/Dialog.tsx#Dialog', file: 'src/Dialog.tsx', component: 'Dialog', versions: 3, changed: 2, states: 1 }]);

    const frames = await (await get(`/api/history/frames?state=${dialog.id}&profile=mobile`)).json() as { frames: Record<string, unknown>[] };
    assert.deepEqual(frames.frames.map((frame) => [frame.iteration, frame.kind, frame.status, frame.imageUrl]), [
      [1, 'baseline', 'captured', `/api/visuals/${frameA}.png`], [2, 'agent_turn', 'captured', `/api/visuals/${frameB}.png`],
    ]);
    const all = await (await get(`/api/history/frames?state=${dialog.id}`)).json() as { frames: Record<string, unknown>[] };
    assert.deepEqual(all.frames.find((frame) => frame.status === 'path_broken'), {
      checkpointId: second.id, iteration: 2, createdAt: second.createdAt, kind: 'agent_turn', profileId: 'desktop',
      status: 'path_broken', captureMode: 'live', reason: 'Step 2 of 2: no recorded locator matched',
    });
    const versions = await (await get(`/api/history/components?key=${encodeURIComponent('src/Dialog.tsx#Dialog')}&state=${dialog.id}&profile=mobile`)).json() as { versions: Record<string, unknown>[] };
    assert.deepEqual(versions.versions.map((version) => [version.iteration, version.occurrence, version.imageUrl, version.box]), [
      [1, 0, `/api/visuals/${cropA}.png`, box], [2, 0, `/api/visuals/${cropB}.png`, box], [2, 1, `/api/visuals/${cropA}.png`, box],
    ]);
    assert.deepEqual((await (await get('/api/history/components?key=src%2FOther.tsx%23Other')).json()), { versions: [] });

    const image = await get(`/api/visuals/${cropB}.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(await image.text(), 'crop-b');
    assert.equal((await get(`/api/visuals/${stray}.png`)).status, 404, 'an unreferenced file in visuals/ is never served');
    assert.equal((await get('/api/visuals/../index.sqlite')).status, 404);
    for (const path of ['/api/history/frames?state=not-a-state', `/api/history/frames?state=${dialog.id}&profile=Mobile!`,
      `/api/history/components?key=${'x'.repeat(513)}`, '/api/history/components', `/api/history/components?key=a%23B&state=bad`]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal((await fetch(`${base}/api/history`, { method: 'POST', headers })).status, 405);

    // The legacy timeline payload is unchanged by screen history.
    const legacy = await (await get('/api/checkpoints')).json() as { checkpoints: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(legacy.checkpoints[0]!).sort(), ['createdAt', 'id', 'kind', 'previewStatus', 'targets']);
  } finally {
    await viewer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
