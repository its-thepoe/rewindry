import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { decodePng } from '../../src/png.ts';
import { captureUiHistory } from '../../src/ui-capture.ts';
import { startAttributionApp } from './attribution-app.ts';

// React 18 is not installed in this repository. Point REWINDRY_REACT18_NODE_MODULES at a node_modules
// containing react@18, react-dom@18, @vitejs/plugin-react and vite; it is only read.
const nodeModules = process.env.REWINDRY_REACT18_NODE_MODULES;
const version = (name: string) => nodeModules && existsSync(join(nodeModules, name, 'package.json'))
  ? (JSON.parse(readFileSync(join(nodeModules, name, 'package.json'), 'utf8')) as { version: string }).version : undefined;
const skip = !nodeModules ? 'set REWINDRY_REACT18_NODE_MODULES to run' : !version('react')?.startsWith('18.') ? `react ${version('react')} is not 18.x` : false;

test('React 18 pages attribute components through _debugSource with project-relative keys', { timeout: 120_000, skip }, async (t) => {
  t.diagnostic(`react ${version('react')}, react-dom ${version('react-dom')}, vite ${version('vite')}, @vitejs/plugin-react ${version('@vitejs/plugin-react')}`);
  const app = await startAttributionApp(nodeModules!, 'react18-e2e', '/');
  try {
    const dialogState = app.store.upsertUiState({
      origin: 'learned', route: '/', componentSet: 'a'.repeat(64), components: [],
      path: [{ action: 'click', target: [{ by: 'role', role: 'button', name: 'Item 2', index: 0 }] }],
    });
    const checkpoint = app.store.snapshot('baseline')!;
    const summary = await captureUiHistory(app.root, app.store, checkpoint, {
      previewUrl: app.previewUrl, appId: app.appId,
      profiles: [{ id: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
    });
    assert.deepEqual([summary.captured, summary.failed, summary.pathBroken], [2, 0, 0], JSON.stringify(summary));
    const dialog = app.store.listUiStates().find((state) => state.id === dialogState.id)!;
    // esbuild (Vite 6) renames a memo's inner `function Cell` that shadows `const Cell` to `Cell2`; the name is
    // stable from build to build, so history still lines up.
    const cellKey = dialog.components.find((key) => key.startsWith('src/attribution/Cell.tsx#Cell'))!;
    assert.match(cellKey, /^src\/attribution\/Cell\.tsx#Cell\d*$/);
    assert.deepEqual(dialog.components.filter((key) => key !== cellKey), [
      'src/attribution/Badge.tsx#Badge', 'src/attribution/Board.tsx#Board',
      'src/attribution/Header.tsx#Header', 'src/attribution/ItemDialog.tsx#ItemDialog', 'src/attribution/main.tsx#App',
    ]);
    assert.deepEqual(app.store.listComponentVersions(cellKey, 'mobile')
      .filter((version) => version.stateId === dialogState.id).map((version) => version.occurrence), [0, 1, 2]);
    const [crop] = app.store.listComponentVersions('src/attribution/ItemDialog.tsx#ItemDialog', 'mobile');
    const image = decodePng(app.store.readVisual(crop!.cropDigest));
    assert.ok(Math.abs(image.width - crop!.box.width * 2) <= 1, 'the portaled dialog is cropped whole');
  } finally {
    await app.close();
  }
});
