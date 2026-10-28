import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ViewerServer } from '../../src/api.ts';
import { decodePng } from '../../src/png.ts';
import { WorkspaceStore } from '../../src/store.ts';

const DIALOG = 'src/attribution/ItemDialog.tsx#ItemDialog';

test('backfill replays a learned dialog onto older checkpoints as labelled per-component history', { timeout: 240_000 }, async () => {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-ui-backfill-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  cpSync(join(example, 'attribution.html'), join(root, 'index.html'));
  cpSync(join(example, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'vite.config.ts'), [
    `import { defineConfig } from 'vite';`,
    `import react from '@vitejs/plugin-react';`,
    `import { rewindryPreviewPlugin } from ${JSON.stringify(resolve('dist/vite-plugin.js'))};`,
    `export default defineConfig({ plugins: [react(), rewindryPreviewPlugin('ui-backfill-e2e', { widget: false })] });`,
  ].join('\n'));
  const dialogFile = join(root, 'src', 'attribution', 'ItemDialog.tsx');
  const dialogSource = readFileSync(dialogFile, 'utf8');
  const store = new WorkspaceStore(root);
  store.initialize();
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { appId: 'ui-backfill-e2e', route: '/?welcome=1' } }));

  // Two older iterations that were never captured: a white dialog, then a yellow one. The working tree is blue now.
  const white = store.snapshot('baseline');
  writeFileSync(dialogFile, dialogSource.replace("background: '#fff'", "background: '#fde68a'"));
  const yellow = store.snapshot('agent_turn', 'turn-yellow');
  assert.ok(white && yellow);
  writeFileSync(dialogFile, dialogSource.replace("background: '#fff'", "background: '#bfdbfe'"));
  // The path a browser visit would have taught (see recorder.test.ts): close the welcome modal, open item 2.
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const dialogState = store.upsertUiState({
    origin: 'learned', route: '/?welcome=1', componentSet: hash('dialog-state'), components: [DIALOG],
    path: [
      { action: 'click', target: [{ by: 'role', role: 'button', name: 'Close welcome', index: 0 }] },
      { action: 'click', target: [{ by: 'role', role: 'button', name: 'Item 2', index: 0 }] },
    ],
  });
  const historyBefore = store.list().map(({ id, digest, createdAt }) => ({ id, digest, createdAt }));

  let output = '';
  const backfill = spawn(process.execPath, [resolve('dist/cli.js'), 'backfill', '--run-historical-source', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [backfill.stdout, backfill.stderr]) stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  assert.equal(await new Promise<number | null>((done) => backfill.once('exit', done)), 0, output);
  assert.match(output, /Backfill complete: 2 captured, 0 partial, 0 unavailable\./);
  assert.match(output, /Screen history: \d+ captured, \d+ unchanged, 0 unreachable, 0 failed, 0 skipped\./, output);

  try {
    // Source history is untouched; temporary copies are gone; the working tree is still blue.
    assert.deepEqual(store.list().map(({ id, digest, createdAt }) => ({ id, digest, createdAt })), historyBefore);
    assert.deepEqual(readdirSync(join(root, '.rewindry', 'tmp')), []);
    assert.match(readFileSync(dialogFile, 'utf8'), /#bfdbfe/);

    for (const profile of ['mobile', 'tablet', 'desktop']) {
      const versions = store.listComponentVersions(DIALOG, profile).filter((version) => version.stateId === dialogState.id);
      assert.deepEqual(versions.map((version) => [version.checkpointId, version.captureMode, version.unchangedFrom]),
        [[white.id, 'replayed', undefined], [yellow.id, 'replayed', undefined]], profile);
    }
    // Each replay rendered that checkpoint's own saved colour.
    const desktop = store.listComponentVersions(DIALOG, 'desktop').filter((version) => version.stateId === dialogState.id);
    const colour = (digest: string) => {
      const image = decodePng(store.readVisual(digest));
      const offset = ((image.height - 4) * image.width + 8) * 4;
      return [...image.data.subarray(offset, offset + 3)];
    };
    assert.deepEqual(colour(desktop[0]!.cropDigest), [0xff, 0xff, 0xff]);
    assert.deepEqual(colour(desktop[1]!.cropDigest), [0xfd, 0xe6, 0x8a]);
    // Replays of old code never rewrite what the state means today.
    assert.deepEqual(store.listUiStates().find((state) => state.id === dialogState.id)?.components, [DIALOG]);

    // The Screens page labels replayed versions.
    const viewer = new ViewerServer(root, store);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${await viewer.start()}`);
      await page.goto(new URL('/history', page.url()).toString());
      const component = page.getByLabel('Component', { exact: true });
      await component.waitFor();
      await component.selectOption({ label: await component.locator('option', { hasText: 'ItemDialog' }).innerText() });
      await page.getByLabel('Breakpoint').selectOption('mobile');
      await page.waitForFunction(() => document.querySelectorAll('.filmstrip .frame').length === 2);
      assert.deepEqual(await page.locator('.filmstrip .frame span').allInnerTexts(), ['Iteration 1', 'Iteration 2']);
      for (const text of await page.locator('.filmstrip .frame small').allInnerTexts()) assert.match(text, /Replayed from saved source/);
      assert.match(await page.locator('.stage-items .replay-note').innerText(), /saved files/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    } finally {
      await browser.close();
      await viewer.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backfill serves old source with a Vite config named in preview.viteConfig, even one an old checkpoint did not save', { timeout: 240_000 }, async () => {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-named-config-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  cpSync(join(example, 'attribution.html'), join(root, 'index.html'));
  cpSync(join(example, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  // Like bingo-demo: no vite.config.*, and the config reads a file from the working directory (as Tailwind finds
  // tailwind.config.js). Its plugin paints the page with that file, so frames show whether both worked.
  writeFileSync(join(root, 'paint.css'), 'html, body { background: #0b6d65; }');
  writeFileSync(join(root, 'vite.demo.config.ts'), [
    `import { readFileSync } from 'node:fs';`,
    `import { defineConfig } from 'vite';`,
    `import react from '@vitejs/plugin-react';`,
    `const paint = { name: 'paint', transformIndexHtml: (html) => html.replace('</head>', \`<style>\${readFileSync('paint.css', 'utf8')}</style></head>\`) };`,
    `export default defineConfig({ plugins: [react(), paint] });`,
  ].join('\n'));
  const dialogFile = join(root, 'src', 'attribution', 'ItemDialog.tsx');
  const dialogSource = readFileSync(dialogFile, 'utf8');
  const config = (preview: Record<string, unknown>) => writeFileSync(join(root, '.rewindry', 'config.json'),
    JSON.stringify({ preview: { appId: 'named-config-e2e', route: '/?welcome=1', profiles: [{ id: 'desktop', width: 1280, height: 800 }], ...preview } }));
  try {
    const before = new WorkspaceStore(root);
    before.initialize();
    config({});
    const white = before.snapshot('baseline')!;
    assert.ok(!white.files.some((file) => file.path === 'vite.demo.config.ts'), 'taken before the config was named');
    config({ viteConfig: 'vite.demo.config.ts', viteConfigLoader: 'runner' });
    const store = new WorkspaceStore(root);
    store.initialize();
    writeFileSync(dialogFile, dialogSource.replace("background: '#fff'", "background: '#fde68a'"));
    const yellow = store.snapshot('agent_turn', 'turn-yellow')!;
    assert.ok(yellow.files.some((file) => file.path === 'vite.demo.config.ts'), 'saved once named');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const dialogState = store.upsertUiState({
      origin: 'learned', route: '/?welcome=1', componentSet: hash('dialog-state'), components: [DIALOG],
      path: [
        { action: 'click', target: [{ by: 'role', role: 'button', name: 'Close welcome', index: 0 }] },
        { action: 'click', target: [{ by: 'role', role: 'button', name: 'Item 2', index: 0 }] },
      ],
    });

    let output = '';
    const backfill = spawn(process.execPath, [resolve('dist/cli.js'), 'backfill', '--run-historical-source', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [backfill.stdout, backfill.stderr]) stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    assert.equal(await new Promise<number | null>((done) => backfill.once('exit', done)), 0, output);
    assert.match(output, new RegExp(`${white.id}: vite\\.demo\\.config\\.ts was not saved with this checkpoint; using today's copy\\.`));
    assert.match(output, /Screen history: \d+ captured, \d+ unchanged, 0 unreachable, 0 failed, 0 skipped\./, output);
    assert.deepEqual(readdirSync(join(root, '.rewindry', 'tmp')), []);

    const versions = store.listComponentVersions(DIALOG, 'desktop').filter((version) => version.stateId === dialogState.id);
    assert.deepEqual(versions.map((version) => version.checkpointId), [white.id, yellow.id]);
    const colour = (digest: string) => {
      const image = decodePng(store.readVisual(digest));
      const offset = ((image.height - 4) * image.width + 8) * 4;
      return [...image.data.subarray(offset, offset + 3)];
    };
    assert.deepEqual(versions.map((version) => colour(version.cropDigest)), [[0xff, 0xff, 0xff], [0xfd, 0xe6, 0x8a]]);
    // Both iterations were served through the named config: its page colour is in every replayed frame.
    const frames = store.listScreenFrames(dialogState.id, 'desktop').filter((frame) => frame.imageDigest);
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      const image = decodePng(store.readVisual(frame.imageDigest!));
      assert.deepEqual([...image.data.subarray(((2 * image.width) + 2) * 4, ((2 * image.width) + 2) * 4 + 3)], [0x0b, 0x6d, 0x65], frame.checkpointId);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
