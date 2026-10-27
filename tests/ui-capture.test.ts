import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cropImage, decodePng, encodePng, type RgbaImage } from '../src/png.ts';
import { WorkspaceStore, type UiState } from '../src/store.ts';
import { captureUiHistory, changedFiles, normalizeProfiles, pickCropSources, selectStates, type CaptureProfile, type FrameRenderer, type RenderResult } from '../src/ui-capture.ts';
import { LANDING_SET, componentSetHash, type InteractionStep } from '../src/ui-states.ts';

function solid(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y);
    data.set([r, g, b, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test('PNG encode, decode and crop round-trip deterministically', () => {
  const image = solid(6, 4, (x, y) => [x * 40, y * 60, 7]);
  const bytes = encodePng(image);
  assert.deepEqual(encodePng(decodePng(bytes)), bytes);
  assert.deepEqual(decodePng(bytes).data, image.data);
  const crop = cropImage(image, { x: 4.5, y: -2, width: 10, height: 3 })!;
  assert.deepEqual([crop.width, crop.height], [2, 1]);
  assert.deepEqual([...crop.data.subarray(0, 4)], [160, 0, 7, 255]);
  assert.equal(cropImage(image, { x: 10, y: 0, width: 5, height: 5 }), null);
  assert.throws(() => decodePng(Buffer.from('not a png')), /Not a PNG/);
});

test('profiles default to mobile, tablet and desktop and reject invalid configuration', () => {
  assert.deepEqual(normalizeProfiles(undefined).map((profile) => [profile.id, profile.width, profile.deviceScaleFactor]),
    [['mobile', 390, 2], ['tablet', 768, 2], ['desktop', 1280, 1]]);
  assert.deepEqual(normalizeProfiles([{ id: 'watch', width: 200, height: 240 }])[0], {
    id: 'watch', label: 'watch', width: 200, height: 240, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
  });
  for (const value of [[], [{ id: 'A', width: 1, height: 1 }], [{ id: 'a', width: 0, height: 1 }], [{ id: 'a', width: 1, height: 1, deviceScaleFactor: 4 }],
    [{ id: 'a', width: 1, height: 1 }, { id: 'a', width: 1, height: 1 }], Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, width: 1, height: 1 }))]) {
    assert.throws(() => normalizeProfiles(value), /profile/i, JSON.stringify(value));
  }
});

const state = (id: string, components: string[], modules: string[] = [], lastSeenAt = id): UiState => ({
  id, origin: 'learned', route: '/', path: [], componentSet: id, components, modules, status: 'active', firstSeenAt: lastSeenAt, lastSeenAt,
});

test('state selection puts the landing page first, then states rendering changed files, within budget', () => {
  const landing = state('landing', ['src/App.tsx#App']);
  const dialog = state('dialog', ['src/App.tsx#App', 'src/ItemDialog.tsx#ItemDialog']);
  const sheet = state('sheet', ['src/Sheet.tsx#Sheet'], ['src/sheet.css']);
  const profile = state('profile', ['src/Profile.tsx#Profile']);
  const all = [profile, sheet, dialog, landing];
  assert.deepEqual(selectStates(all, new Set(['src/ItemDialog.tsx']), 'landing', 12).selected.map((item) => item.id), ['landing', 'dialog']);
  assert.deepEqual(selectStates(all, new Set(['src/sheet.css']), 'landing', 12).selected.map((item) => item.id), ['landing', 'sheet']);
  // A change no state renders falls back to the most recently used states.
  assert.deepEqual(selectStates(all, new Set(['src/global.css']), 'landing', 3), { selected: [landing, profile, sheet], skipped: [] });
  const tight = selectStates(all, new Set(['src/App.tsx', 'src/Sheet.tsx']), 'landing', 2);
  assert.deepEqual(tight.selected.map((item) => item.id), ['landing', 'sheet']);
  assert.deepEqual(tight.skipped.map((item) => item.id), ['dialog']);
});

async function previewServer(): Promise<{ url: string; server: Server; identity: { appId: string; serverId: string; generation: number; readiness: string } }> {
  const identity = { appId: 'ui-test', serverId: 'server-1', generation: 0, readiness: 'idle' };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(request.url === '/__rewindry/preview' ? JSON.stringify(identity) : '{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/`, server, identity };
}

type Scene = { color: [number, number, number]; dialogColor?: [number, number, number]; broken?: boolean };

// Renders 20×10 CSS-pixel pages; the dialog state adds a 4×4 component at (2,2).
function fakeRenderer(scene: () => Scene, calls: string[]): FrameRenderer {
  return {
    async render(url: string, profile: CaptureProfile, path: InteractionStep[]): Promise<RenderResult> {
      calls.push(`${new URL(url).pathname}${path.length ? '+dialog' : ''}@${profile.id}`);
      const current = scene();
      if (path.length && current.broken) return { status: 'path_broken', reason: 'Step 1 of 1: no recorded locator matched' };
      const scale = profile.deviceScaleFactor;
      const dialog = path.length > 0;
      const png = encodePng(solid(20 * scale, 10 * scale, (x, y) =>
        dialog && x >= 2 * scale && x < 6 * scale && y >= 2 * scale && y < 6 * scale ? current.dialogColor ?? [0, 0, 0] : current.color));
      const components = [{ key: 'src/App.tsx#App', file: 'src/App.tsx', component: 'App', occurrence: 0, box: { x: 0, y: 0, width: 20, height: 10 } }];
      if (dialog) components.push({ key: 'src/ItemDialog.tsx#ItemDialog', file: 'src/ItemDialog.tsx', component: 'ItemDialog', occurrence: 0, box: { x: 2, y: 2, width: 4, height: 4 } });
      return { status: 'captured', png, components };
    },
    async close() {},
  };
}

test('per-screen capture keeps only real visual changes for screens and components', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-ui-capture-'));
  const preview = await previewServer();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'App.tsx'), 'app v1');
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v1');
    const store = new WorkspaceStore(root);
    store.initialize();
    const dialogPath = [{ action: 'click', target: [{ by: 'role', role: 'button', name: 'Item 2', index: 0 }] }];
    const dialogState = store.upsertUiState({ origin: 'learned', route: '/', path: dialogPath, componentSet: componentSetHash(['src/App.tsx#App', 'src/ItemDialog.tsx#ItemDialog']),
      components: ['src/App.tsx#App', 'src/ItemDialog.tsx#ItemDialog'] });
    let scene: Scene = { color: [255, 255, 255], dialogColor: [200, 0, 0] };
    const calls: string[] = [];
    const options = { previewUrl: preview.url, appId: 'ui-test', profiles: [{ id: 'mobile', width: 20, height: 10, deviceScaleFactor: 2 }, { id: 'desktop', width: 20, height: 10 }], renderer: fakeRenderer(() => scene, calls) };

    const first = store.snapshot('baseline')!;
    assert.deepEqual(await captureUiHistory(root, store, first, options), { states: 2, captured: 4, unchanged: 0, pathBroken: 0, failed: 0, skipped: 0 });
    const landing = store.listUiStates().find((item) => item.componentSet === LANDING_SET)!;
    assert.equal(landing.origin, 'configured', 'the landing page gets history without any browser visit');
    assert.deepEqual(landing.components, ['src/App.tsx#App']);
    assert.deepEqual(calls, ['/@mobile', '/@desktop', '/+dialog@mobile', '/+dialog@desktop']);

    // Dialog copy changes its pixels; the landing page and App's own crop are not affected by the dialog file.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v2');
    scene = { color: [255, 255, 255], dialogColor: [0, 0, 200] };
    const second = store.snapshot('unattributed_group')!;
    assert.deepEqual([...changedFiles(store, second)], ['src/ItemDialog.tsx']);
    assert.deepEqual(await captureUiHistory(root, store, second, options), { states: 2, captured: 2, unchanged: 2, pathBroken: 0, failed: 0, skipped: 0 });

    // A comment-only change re-renders identically: frames and crops point back to the earlier versions.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v2 // comment');
    const third = store.snapshot('unattributed_group')!;
    await captureUiHistory(root, store, third, options);
    const dialogFrames = store.listScreenFrames(dialogState.id, 'mobile');
    assert.deepEqual(dialogFrames.map((frame) => [frame.checkpointId, frame.status, frame.unchangedFrom]),
      [[first.id, 'captured', undefined], [second.id, 'captured', undefined], [third.id, 'unchanged', second.id]]);
    const dialogVersions = store.listComponentVersions('src/ItemDialog.tsx#ItemDialog', 'mobile');
    assert.deepEqual(dialogVersions.map((version) => version.unchangedFrom), [undefined, undefined, second.id]);
    assert.notEqual(dialogVersions[0]!.cropDigest, dialogVersions[1]!.cropDigest);
    const crop = decodePng(store.readVisual(dialogVersions[1]!.cropDigest));
    assert.deepEqual([crop.width, crop.height, ...crop.data.subarray(0, 4)], [8, 8, 0, 0, 200, 255], 'crops use device pixels');
    const app = store.listComponentVersions('src/App.tsx#App', 'desktop').filter((version) => version.stateId === landing.id);
    assert.deepEqual(app.map((version) => version.unchangedFrom), [undefined, first.id, first.id]);

    // Rerunning the same checkpoint is a no-op.
    const before = calls.length;
    assert.equal((await captureUiHistory(root, store, third, options)).captured, 0);
    assert.equal(calls.length, before);

    // A path that no longer works is recorded and the last good images stay.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v3');
    scene = { ...scene, broken: true };
    const fourth = store.snapshot('unattributed_group')!;
    assert.equal((await captureUiHistory(root, store, fourth, options)).pathBroken, 2);
    assert.equal(store.listUiStates().find((item) => item.id === dialogState.id)!.status, 'path_broken');
    assert.equal(store.listScreenFrames(dialogState.id, 'mobile').filter((frame) => frame.status === 'captured').length, 2);
    // ...and the next working replay repairs it.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v4');
    scene = { color: [255, 255, 255], dialogColor: [0, 0, 200] };
    await captureUiHistory(root, store, store.snapshot('unattributed_group')!, options);
    assert.equal(store.listUiStates().find((item) => item.id === dialogState.id)!.status, 'active');

    // Over budget: touched states that do not fit are recorded as skipped, not silently dropped.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v5');
    const budget = await captureUiHistory(root, store, store.snapshot('unattributed_group')!, { ...options, maxFrames: 2 });
    assert.deepEqual([budget.states, budget.skipped], [1, 2]);

    // Replayed mode (backfill) labels frames and checks the given source tree, but never rewrites the
    // state's current component list or path status from old code.
    const statesBefore = store.listUiStates();
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v5b');
    const replayedCheckpoint = store.snapshot('unattributed_group')!;
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'working tree moved on');
    scene = { ...scene, broken: true };
    const replayed = await captureUiHistory(root, store, replayedCheckpoint, { ...options, captureMode: 'replayed', sourceDigest: () => replayedCheckpoint.digest });
    assert.equal(replayed.pathBroken, 2);
    assert.deepEqual(store.listScreenFrames(landing.id).filter((frame) => frame.checkpointId === replayedCheckpoint.id).map((frame) => frame.captureMode), ['replayed', 'replayed']);
    assert.ok(store.listComponentVersions('src/App.tsx#App').filter((version) => version.checkpointId === replayedCheckpoint.id).every((version) => version.captureMode === 'replayed'));
    assert.deepEqual(store.listUiStates().map((item) => [item.id, item.status, item.components]), statesBefore.map((item) => [item.id, item.status, item.components]));
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v5b');
    scene = { ...scene, broken: false };

    // If the source changes while rendering, nothing from that run is published.
    writeFileSync(join(root, 'src', 'ItemDialog.tsx'), 'dialog v6');
    const raced = store.snapshot('unattributed_group')!;
    const racing: FrameRenderer = {
      render: async (...args) => { writeFileSync(join(root, 'src', 'App.tsx'), 'moved'); return fakeRenderer(() => scene, []).render(...args); },
      close: async () => {},
    };
    await assert.rejects(captureUiHistory(root, store, raced, { ...options, renderer: racing }), /Source moved during capture/);
    assert.equal(store.listScreenFrames(landing.id).some((frame) => frame.checkpointId === raced.id), false);
  } finally {
    preview.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const instance = (key: string, x: number, y: number, width: number, height: number, occurrence = 0) =>
  ({ key, file: key.split('#')[0]!, component: key.split('#')[1]!, occurrence, box: { x, y, width, height } });

test('crops come from the first screenshot that shows the whole component, else the one showing most of it', () => {
  const image = { width: 100, height: 100 };
  const picked = pickCropSources([
    { image, components: [instance('a#Top', 0, 0, 50, 50), instance('a#Below', 0, 150, 50, 50), instance('a#Tall', 0, 60, 50, 200)] },
    { image, components: [instance('a#Top', 0, -90, 50, 50), instance('a#Below', 0, 60, 50, 30), instance('a#Tall', 0, -30, 50, 200), instance('a#Late', 0, 10, 20, 20)] },
  ], 1);
  assert.deepEqual(picked.map((item) => [item.key, item.shot, item.box.y]), [
    ['a#Top', 0, 0], ['a#Below', 1, 60], ['a#Tall', 1, -30], ['a#Late', 1, 10],
  ]);
  assert.deepEqual(pickCropSources([{ image, components: [instance('a#Gone', 0, 200, 10, 10)] }], 1), [], 'never visible: no crop');
  assert.equal(pickCropSources([{ image, components: [instance('a#Hi', 10, 10, 30, 30)] }], 2)[0]!.shot, 0, 'device pixels are used for visibility');
});

test('inner-scroller shots and React 18 absolute paths feed crops with project-relative keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-ui-scroll-'));
  const preview = await previewServer();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'Board.tsx'), 'board');
    const store = new WorkspaceStore(root);
    store.initialize();
    const checkpoint = store.snapshot('baseline')!;
    const absolute = (file: string) => join(realpathSync(root), file);
    // The frame is the viewport (10 px tall); the board sits 30 px down an inner scroller and only shows in the second shot.
    const renderer: FrameRenderer = {
      async render() {
        const frame = encodePng(solid(20, 10, () => [255, 255, 255]));
        const scrolled = encodePng(solid(20, 10, (x, y) => (y >= 2 && y < 8 && x < 10 ? [0, 120, 0] : [255, 255, 255])));
        return {
          status: 'captured', png: frame,
          components: [instance(`${absolute('src/App.tsx')}#App`, 0, 0, 20, 10), instance(`${absolute('src/Board.tsx')}#Board`, 0, 30, 10, 6), instance('/outside/Lib.tsx#Lib', 0, 0, 5, 5)],
          shots: [{ png: scrolled, components: [instance(`${absolute('src/App.tsx')}#App`, 0, -28, 20, 10), instance(`${absolute('src/Board.tsx')}#Board`, 0, 2, 10, 6)] }],
        };
      },
      async close() {},
    };
    const summary = await captureUiHistory(root, store, checkpoint, { previewUrl: preview.url, appId: 'ui-test', profiles: [{ id: 'mobile', width: 20, height: 10 }], renderer });
    assert.equal(summary.captured, 1);
    const landing = store.listUiStates()[0]!;
    assert.deepEqual(landing.components, ['src/App.tsx#App', 'src/Board.tsx#Board'], 'outside-project components are dropped');
    const board = store.listComponentVersions('src/Board.tsx#Board');
    assert.equal(board.length, 1);
    assert.deepEqual(board[0]!.box, { x: 0, y: 2, width: 10, height: 6 }, 'box is recorded in the shot it was cropped from');
    const crop = decodePng(store.readVisual(board[0]!.cropDigest));
    assert.deepEqual([crop.width, crop.height, ...crop.data.subarray(0, 3)], [10, 6, 0, 120, 0]);
  } finally {
    preview.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
