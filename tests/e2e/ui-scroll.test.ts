import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { decodePng } from '../../src/png.ts';
import { captureUiHistory } from '../../src/ui-capture.ts';
import { startAttributionApp } from './attribution-app.ts';

test('components far down an inner scroller are still cropped', { timeout: 120_000 }, async () => {
  const app = await startAttributionApp(join(resolve('examples/vite-react'), 'node_modules'), 'ui-scroll-e2e', '/?shell=1');
  try {
    const checkpoint = app.store.snapshot('baseline')!;
    const summary = await captureUiHistory(app.root, app.store, checkpoint, {
      previewUrl: app.previewUrl, appId: app.appId, route: '/?shell=1',
      profiles: [{ id: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
    });
    assert.deepEqual([summary.captured, summary.failed], [1, 0], JSON.stringify(summary));
    const [landing] = app.store.listUiStates();
    const [frame] = app.store.listScreenFrames(landing!.id, 'mobile');
    const frameImage = decodePng(app.store.readVisual(frame!.imageDigest!));
    // The document itself does not scroll, so the frame is exactly one viewport.
    assert.deepEqual([frameImage.width, frameImage.height], [780, 1688]);
    // The board starts 1200 px down the inner scroller, beyond the frame, yet every cell has a full crop.
    const cells = app.store.listComponentVersions('src/attribution/Cell.tsx#Cell', 'mobile');
    assert.deepEqual(cells.map((cell) => cell.occurrence), [0, 1, 2]);
    for (const cell of cells) {
      const crop = decodePng(app.store.readVisual(cell.cropDigest));
      // Whole cell: crops round fractional edges outward, so allow one device pixel.
      assert.ok(Math.abs(crop.width - cell.box.width * 2) <= 1 && Math.abs(crop.height - cell.box.height * 2) <= 1,
        `cell ${cell.occurrence}: ${crop.width}×${crop.height} for ${JSON.stringify(cell.box)}`);
      assert.ok(cell.box.y >= 0 && cell.box.y + cell.box.height <= 844, `cell ${cell.occurrence} cropped from a scrolled shot`);
    }
    const board = app.store.listComponentVersions('src/attribution/Board.tsx#Board', 'mobile');
    assert.equal(board.length, 1);
  } finally {
    await app.close();
  }
});
