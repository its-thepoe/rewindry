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
