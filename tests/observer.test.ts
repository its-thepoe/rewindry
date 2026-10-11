import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceObserver } from '../src/observer.ts';

test('observer reports source writes and ignores its own store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-observer-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.rewindry'));
  let changes = 0;
  const observer = new WorkspaceObserver(root, () => { changes++; });
  try {
    await observer.start();
    writeFileSync(join(root, '.rewindry', 'journal.jsonl'), 'internal');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(changes, 0);
    writeFileSync(join(root, 'src', 'app.ts'), 'visible');
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (changes > 0) return resolve();
        if (Date.now() > deadline) return reject(new Error('source write was not observed'));
        setTimeout(poll, 25);
      };
      poll();
    });
    assert.ok(changes > 0);
  } finally {
    await observer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('digest reconciliation reports each tree change once, including a missed watcher event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-rescan-'));
  const source = join(root, 'app.ts');
  writeFileSync(source, 'initial');
  let changes = 0;
  let digest = () => readFileSync(source, 'utf8');
  const observer = new WorkspaceObserver(root, () => { changes++; }, {
    digest: () => digest(),
    rescanIntervalMs: 50,
  });
  try {
    await observer.start();
    writeFileSync(source, 'changed');
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (changes === 1) return resolve();
        if (Date.now() > deadline) return reject(new Error('first change was not observed'));
        setTimeout(poll, 20);
      };
      poll();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(changes, 1);

    digest = () => 'missed-event-tree';
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (changes === 2) return resolve();
        if (Date.now() > deadline) return reject(new Error('rescan did not reconcile a missed event'));
        setTimeout(poll, 20);
      };
      poll();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(changes, 2);
  } finally {
    await observer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('watcher errors immediately reconcile missed writes and retain a degraded diagnostic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-overflow-'));
  let digest = 'baseline';
  let changes = 0;
  const observer = new WorkspaceObserver(root, () => { changes++; }, { digest: () => digest });
  try {
    await observer.start();
    digest = 'after-overflow';
    const watcher = (observer as unknown as { watcher?: { emit: (event: string, error: Error) => boolean } }).watcher;
    assert.ok(watcher);
    watcher.emit('error', new Error('injected filesystem overflow'));
    assert.equal(changes, 1);
    assert.ok(observer.diagnostics.some((entry) => entry.includes('watcher_error:') && entry.includes('injected filesystem overflow')));
  } finally {
    await observer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
