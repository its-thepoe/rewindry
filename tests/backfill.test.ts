import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBackfill, materializeCheckpointSnapshot } from '../src/backfill.ts';
import { runCli } from '../src/cli.ts';
import { captureBackfillVariants, type PreviewRecord } from '../src/capture.ts';
import { WorkspaceStore, type Checkpoint } from '../src/store.ts';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-backfill-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'initial');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function targetConfig() {
  return [{ id: 'home', label: 'Home', route: '/', viewports: [{ id: 'desktop', label: 'Desktop', width: 1280, height: 800 }] }];
}

async function identityServer(readIdentity: () => { appId: string; serverId: string; generation: number; readiness: string }) {
  const server = createServer((request, response) => {
    if (request.url !== '/__rewindry/backfill-preview') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(readIdentity()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    previewUrl: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function successfulRecord(checkpoint: Checkpoint): PreviewRecord {
  return {
    checkpointId: checkpoint.id,
    status: 'captured',
    sourceDigest: checkpoint.digest,
    appId: 'fixture',
    route: '/',
    viewport: { width: 1280, height: 800 },
    fidelityLimits: [],
    targets: [{
      targetId: 'home', targetLabel: 'Home', viewportId: 'desktop', viewportLabel: 'Desktop', route: '/',
      viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
      status: 'captured', captureMode: 'replayed', replayedAt: new Date().toISOString(),
    }],
  };
}

test('backfill acknowledgement guard returns before creating workspace storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-backfill-ack-'));
  const dataDir = join(root, 'user-data');
  const project = join(root, 'project');
  mkdirSync(project);
  try {
    const errors: string[] = [];
    const code = await runCli(['backfill', '--root', project, '--data-dir', dataDir], { out: () => {}, error: (line) => errors.push(line) });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /--run-historical-source/);
    assert.equal(existsSync(join(project, '.rewindry')), false);
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot materialization reads saved checkpoint bytes and rejects traversal before writing', () => {
  const { root, cleanup } = fixture();
  const snapshot = join(root, 'snapshot');
  mkdirSync(snapshot);
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  writeFileSync(join(root, 'src', 'app.ts'), 'current source');
  try {
    materializeCheckpointSnapshot(snapshot, checkpoint, store);
    assert.equal(readFileSync(join(snapshot, 'src', 'app.ts'), 'utf8'), 'initial');
    const outside = join(root, 'outside.txt');
    const malicious = { ...checkpoint, files: [{ ...checkpoint.files[0]!, path: '../outside.txt' }] };
    assert.throws(() => materializeCheckpointSnapshot(snapshot, malicious, store), /Unsafe checkpoint path/);
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(join(snapshot, '..', 'outside.txt')), false);
  } finally {
    cleanup();
  }
});

test('backfill processes checkpoints oldest-first from saved bytes and cleans each temporary snapshot', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const first = store.snapshot('baseline');
  assert.ok(first);
  writeFileSync(join(root, 'src', 'app.ts'), 'second saved state');
  const second = store.snapshot('agent_turn', 'turn-2');
  assert.ok(second);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { backfill: 'touch package-script-ran' } }));
  const order: string[] = [];
  const snapshots: string[] = [];
  const temporaryRoots: string[] = [];
  const output: string[] = [];
  try {
    const summary = await runBackfill(root, { out: (line) => output.push(line), error: (line) => output.push(line) }, {
      startPreview: async (snapshotRoot, _appId, checkpointId) => {
        temporaryRoots.push(snapshotRoot);
        order.push(checkpointId);
        snapshots.push(readFileSync(join(snapshotRoot, 'src', 'app.ts'), 'utf8'));
        return { previewUrl: 'http://127.0.0.1:1/', close: async () => {} };
      },
      capture: async (_activeRoot, sourceStore, checkpoint) => {
        assert.equal(sourceStore.currentDigest(), checkpoint.digest);
        return successfulRecord(checkpoint);
      },
    });
    assert.deepEqual(order, [first.id, second.id]);
    assert.deepEqual(snapshots, ['initial', 'second saved state']);
    assert.deepEqual(summary, { captured: 2, partial: 0, unavailable: 0, screens: { captured: 0, unchanged: 0, pathBroken: 0, failed: 0, skipped: 0, unavailable: 0 } });
    assert.equal(output.some((line) => line.includes('Backfill 1/2')), true);
    assert.equal(temporaryRoots.every((path) => !existsSync(path)), true);
    assert.equal(existsSync(join(root, 'package-script-ran')), false);
    const tempEntries = readdirSync(join(root, '.rewindry', 'tmp'));
    assert.deepEqual(tempEntries, []);
  } finally {
    cleanup();
  }
});

test('backfill cleans the exact temporary directory after replay startup failure', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  let temporaryRoot = '';
  try {
    const summary = await runBackfill(root, { out: () => {}, error: () => {} }, {
      startPreview: async (snapshotRoot) => {
        temporaryRoot = snapshotRoot;
        throw new Error('historical Vite config unavailable');
      },
      capture: async (_activeRoot, _sourceStore, selected, options) => {
        assert.match(options.unavailableReason ?? '', /Vite config unavailable/);
        return {
          ...successfulRecord(selected),
          status: 'source_only',
          targets: successfulRecord(selected).targets?.map((target) => ({ ...target, status: 'source_only', reason: options.unavailableReason })),
        };
      },
    });
    assert.deepEqual(summary, { captured: 0, partial: 0, unavailable: 1, screens: { captured: 0, unchanged: 0, pathBroken: 0, failed: 0, skipped: 0, unavailable: 0 } });
    assert.equal(existsSync(temporaryRoot), false);
    assert.deepEqual(readdirSync(join(root, '.rewindry', 'tmp')), []);
  } finally {
    cleanup();
  }
});

test('replayed variants preserve a legacy primary, create a primary when absent and skip successful pairs on retry', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const directory = join(root, '.rewindry', 'previews', checkpoint.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'primary.png'), 'legacy-primary');
  writeFileSync(join(directory, 'primary.json'), JSON.stringify({
    checkpointId: checkpoint.id, status: 'captured', sourceDigest: checkpoint.digest, appId: 'fixture',
    route: '/old', viewport: { width: 800, height: 600 }, fidelityLimits: [],
  }));
  const identity = { appId: 'fixture', serverId: 'backfill', generation: 0, readiness: 'idle' };
  const server = await identityServer(() => identity);
  const options = {
    appId: 'fixture', previewUrl: server.previewUrl, identityPath: '/__rewindry/backfill-preview',
    targets: targetConfig(), capturePage: async () => Buffer.from('replayed-image'),
  };
  try {
    const merged = await captureBackfillVariants(root, store, checkpoint, options);
    assert.equal(readFileSync(join(directory, 'primary.png'), 'utf8'), 'legacy-primary');
    assert.equal(readFileSync(join(directory, 'home--desktop.png'), 'utf8'), 'replayed-image');
    const replayedTarget = merged.targets?.find((target) => target.targetId === 'home');
    assert.equal(replayedTarget?.captureMode, 'replayed');
    assert.match(replayedTarget?.replayedAt ?? '', /^\d{4}-/);
    assert.equal(replayedTarget?.imageFile, 'home--desktop.png');

    writeFileSync(join(root, 'src', 'app.ts'), 'changed');
    const next = store.snapshot('agent_turn', 'turn-2');
    assert.ok(next);
    const nextDirectory = join(root, '.rewindry', 'previews', next.id);
    let attempts = 0;
    const created = await captureBackfillVariants(root, store, next, {
      ...options,
      capturePage: async () => { attempts++; return Buffer.from('new-primary'); },
    });
    assert.equal(created.targets?.[0]?.imageFile, 'primary.png');
    assert.equal(readFileSync(join(nextDirectory, 'primary.png'), 'utf8'), 'new-primary');
    const retried = await captureBackfillVariants(root, store, next, {
      ...options,
      capturePage: async () => { throw new Error('successful pair should not be recaptured'); },
    });
    assert.equal(attempts, 1);
    assert.equal(retried.targets?.length, 1);
  } finally {
    await server.close();
    cleanup();
  }
});

test('failed variants retry in place while successful siblings remain available', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const checkpoint = store.snapshot('baseline');
  assert.ok(checkpoint);
  const server = await identityServer(() => ({ appId: 'fixture', serverId: 'retry', generation: 0, readiness: 'idle' }));
  const targets = [{ id: 'home', label: 'Home', route: '/', viewports: [
    { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
    { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
  ] }];
  try {
    const first = await captureBackfillVariants(root, store, checkpoint, {
      appId: 'fixture', previewUrl: server.previewUrl, identityPath: '/__rewindry/backfill-preview', targets,
      capturePage: async (_url, request) => {
        if (request.viewport.width === 1280) throw new Error('desktop unavailable');
        return Buffer.from('mobile-image');
      },
    });
    assert.equal(first.status, 'captured');
    assert.equal(first.targets?.length, 2);
    assert.match(first.targets?.find((target) => target.viewportId === 'desktop')?.reason ?? '', /unavailable/);
    const retryCalls: number[] = [];
    const retried = await captureBackfillVariants(root, store, checkpoint, {
      appId: 'fixture', previewUrl: server.previewUrl, identityPath: '/__rewindry/backfill-preview', targets,
      capturePage: async (_url, request) => { retryCalls.push(request.viewport.width); return Buffer.from('desktop-image'); },
    });
    assert.deepEqual(retryCalls, [1280]);
    assert.equal(retried.targets?.length, 2);
    assert.deepEqual(retried.targets?.map((target) => target.status), ['captured', 'captured']);
  } finally {
    await server.close();
    cleanup();
  }
});

test('backfill replays learned screens against each checkpoint\'s saved files, labelled as replayed, and isolates failures', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const first = store.snapshot('baseline');
  writeFileSync(join(root, 'src', 'app.ts'), 'second saved state');
  const second = store.snapshot('agent_turn', 'turn-2');
  assert.ok(first && second);
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { appId: 'fixture', route: '/?welcome=1', profiles: [{ id: 'watch', width: 200, height: 240 }] } }));
  const calls: { checkpointId: string; digest: string; options: Record<string, unknown> }[] = [];
  const output: string[] = [];
  try {
    const summary = await runBackfill(root, { out: (line) => output.push(line), error: (line) => output.push(line) }, {
      startPreview: async () => ({ previewUrl: 'http://127.0.0.1:1/', close: async () => {} }),
      capture: async (_activeRoot, _sourceStore, checkpoint) => successfulRecord(checkpoint),
      captureUi: async (_root, _store, checkpoint, options) => {
        calls.push({ checkpointId: checkpoint.id, digest: options.sourceDigest!(), options: { ...options, sourceDigest: undefined } });
        if (checkpoint.id === second.id) throw new Error('Preview app identity mismatch');
        return { states: 2, captured: 4, unchanged: 1, pathBroken: 1, failed: 0, skipped: 0 };
      },
    });
    assert.deepEqual(calls.map((call) => call.checkpointId), [first.id, second.id]);
    // Each replay checks the temporary copy of that checkpoint, never the working tree.
    assert.deepEqual(calls.map((call) => call.digest), [first.digest, second.digest]);
    // React 18 paths are made relative to the temporary copy the historical server serves.
    const { sourceRoot, ...options } = calls[0]!.options;
    assert.match(String(sourceRoot), new RegExp(`/\\.rewindry/tmp/${first.id}-`));
    assert.deepEqual(options, {
      previewUrl: 'http://127.0.0.1:1/', appId: 'fixture', route: '/?welcome=1', profiles: [{ id: 'watch', width: 200, height: 240 }],
      identityPath: '/__rewindry/backfill-preview', sourceDigest: undefined, captureMode: 'replayed',
    });
    assert.deepEqual(summary, { captured: 2, partial: 0, unavailable: 0, screens: { captured: 4, unchanged: 1, pathBroken: 1, failed: 0, skipped: 0, unavailable: 1 } });
    assert.ok(output.includes(`Backfill ${second.id}: screens unavailable (Preview app identity mismatch)`));
    assert.ok(output.includes('Screen history: 4 captured, 1 unchanged, 1 unreachable, 0 failed, 0 skipped, 1 checkpoints unavailable.'));
    assert.deepEqual(readdirSync(join(root, '.rewindry', 'tmp')), []);
  } finally {
    cleanup();
  }
});

test('backfill serves old source with the named Vite config, using today\'s copy when a checkpoint did not save it', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const unsaved = store.snapshot('baseline')!;
  writeFileSync(join(root, 'vite.demo.config.ts'), 'export default { define: { TODAY: 1 } }');
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { appId: 'fixture', viteConfig: 'vite.demo.config.ts' } }));
  const named = new WorkspaceStore(root);
  named.initialize();
  writeFileSync(join(root, 'vite.demo.config.ts'), 'export default { define: { SAVED: 1 } }');
  writeFileSync(join(root, 'src', 'app.ts'), 'second saved state');
  const saved = named.snapshot('agent_turn', 'turn-2')!;
  writeFileSync(join(root, 'vite.demo.config.ts'), 'export default { define: { TODAY: 1 } }');
  const served: string[] = [];
  const output: string[] = [];
  try {
    await runBackfill(root, { out: (line) => output.push(line), error: (line) => output.push(line) }, {
      startPreview: async (snapshotRoot) => {
        served.push(readFileSync(join(snapshotRoot, 'vite.demo.config.ts'), 'utf8'));
        return { previewUrl: 'http://127.0.0.1:1/', close: async () => {} };
      },
      capture: async (_activeRoot, sourceStore, checkpoint) => {
        // The borrowed config is not part of the checkpoint, so its source digest still matches.
        assert.equal(sourceStore.currentDigest(), checkpoint.digest);
        return successfulRecord(checkpoint);
      },
    });
    assert.deepEqual(served, ['export default { define: { TODAY: 1 } }', 'export default { define: { SAVED: 1 } }']);
    assert.ok(output.includes(`Backfill ${unsaved.id}: vite.demo.config.ts was not saved with this checkpoint; using today's copy.`), output.join('\n'));
    assert.ok(!output.some((line) => line.startsWith(`Backfill ${saved.id}: vite.demo.config.ts`)));
    writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { appId: 'fixture', viteConfig: '../outside.ts' } }));
    await assert.rejects(runBackfill(root, { out: () => {}, error: () => {} }, {}), /Invalid preview\.viteConfig/);
  } finally {
    cleanup();
  }
});

test('backfill --last N replays only the newest N checkpoints, oldest first, and rejects bad values', async () => {
  const { root, cleanup } = fixture();
  const store = new WorkspaceStore(root);
  store.initialize();
  const ids = [store.snapshot('baseline')!.id];
  for (const state of ['two', 'three', 'four']) {
    writeFileSync(join(root, 'src', 'app.ts'), state);
    ids.push(store.snapshot('agent_turn', `turn-${state}`)!.id);
  }
  const order: string[] = [];
  const output: string[] = [];
  try {
    const summary = await runBackfill(root, { out: (line) => output.push(line), error: (line) => output.push(line) }, {
      startPreview: async (_snapshotRoot, _appId, checkpointId) => { order.push(checkpointId); return { previewUrl: 'http://127.0.0.1:1/', close: async () => {} }; },
      capture: async (_activeRoot, _sourceStore, checkpoint) => successfulRecord(checkpoint),
    }, { last: 2 });
    assert.deepEqual(order, ids.slice(-2));
    assert.equal(summary.captured, 2);
    assert.ok(output.includes('Backfill: the newest 2 of 4 checkpoints.'));
    assert.ok(output.some((line) => /^Backfill time: \d+\.\d s total, \d+\.\d s per checkpoint\.$/.test(line)));
    await assert.rejects(runBackfill(root, { out: () => {}, error: () => {} }, {}, { last: 0 }), /positive whole number/);
    for (const value of ['0', '-1', '2.5', 'many']) {
      const errors: string[] = [];
      const code = await runCli(['backfill', '--run-historical-source', '--last', value, '--root', root], { out: () => {}, error: (line) => errors.push(line) });
      assert.equal(code, 1, value);
      assert.match(errors.join('\n'), /--last needs a whole number|Missing value for --last/, value);
    }
  } finally {
    cleanup();
  }
});
