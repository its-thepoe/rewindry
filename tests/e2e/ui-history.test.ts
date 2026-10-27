import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { decodePng } from '../../src/png.ts';
import { RewindryRuntime } from '../../src/runtime.ts';
import { LANDING_SET } from '../../src/ui-states.ts';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch { /* The dev server may still be starting. */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const DIALOG = 'src/attribution/ItemDialog.tsx#ItemDialog';
const WELCOME = 'src/attribution/WelcomeModal.tsx#WelcomeModal';
const ROUTE = '/?welcome=1';

test('a dialog learned once keeps its own per-breakpoint history after the browser is closed', { timeout: 180_000 }, async () => {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-ui-history-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  cpSync(join(example, 'attribution.html'), join(root, 'index.html'));
  cpSync(join(example, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'vite.config.ts'), [
    `import { defineConfig } from 'vite';`,
    `import react from '@vitejs/plugin-react';`,
    `import { rewindryPreviewPlugin } from ${JSON.stringify(resolve('src/vite-plugin.ts'))};`,
    `export default defineConfig({ plugins: [react(), rewindryPreviewPlugin('ui-history-e2e', { widget: false })], cacheDir: '.vite-cache' });`,
  ].join('\n'));
  const dialogSource = readFileSync(join(root, 'src', 'attribution', 'ItemDialog.tsx'), 'utf8');
  const runtime = new RewindryRuntime(root);
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { route: ROUTE } }));
  runtime.store.snapshot('baseline');

  const vitePort = await port();
  let output = '';
  const server = spawn(process.execPath, [join(example, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4_000); });
  const identity = () => fetch(`http://127.0.0.1:${vitePort}/__rewindry/preview`).then((response) => response.json() as Promise<{ generation: number }>);
  try {
    // The plugin registers the preview URL; capture then runs from config alone.
    await until(() => JSON.parse(readFileSync(join(root, '.rewindry', 'config.json'), 'utf8')).preview, (preview) => !!preview?.url && preview.route === ROUTE, 'preview registration');

    // Ordinary use, once: dismiss the welcome modal and open item 2. Then the browser closes for good.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${vitePort}${ROUTE}`);
      await page.getByRole('button', { name: 'Close welcome' }).click();
      await page.getByRole('button', { name: 'Item 2' }).click();
      await page.getByRole('dialog', { name: 'Item 2' }).waitFor();
      await until(() => runtime.store.listUiStates(), (states) => states.some((state) => state.components.includes(DIALOG)), 'the learned dialog state');
    } finally {
      await browser.close();
    }
    const dialogState = runtime.store.listUiStates().find((state) => state.components.includes(DIALOG))!;
    assert.equal(dialogState.route, ROUTE);
    assert.equal(dialogState.path.length, 2);

    // Three updates with no browser open: two visual changes and a comment-only change.
    const edits = [
      dialogSource.replace("background: '#fff'", "background: '#fde68a'"),
      dialogSource.replace("background: '#fff'", "background: '#bfdbfe'"),
      `${dialogSource.replace("background: '#fff'", "background: '#bfdbfe'")}\n// Copy review pending.\n`,
    ];
    const checkpoints = [];
    for (const source of edits) {
      const generation = (await identity()).generation;
      writeFileSync(join(root, 'src', 'attribution', 'ItemDialog.tsx'), source);
      await until(identity, (value) => value.generation > generation, 'the dev server to see the edit');
      await new Promise((done) => setTimeout(done, 300));
      const checkpoint = runtime.store.snapshot('unattributed_group');
      assert.ok(checkpoint);
      checkpoints.push(checkpoint);
      const record = await runtime.queueCapture(checkpoint);
      assert.equal(record?.status, 'captured', record?.reason ?? '');
      await runtime.uiHistoryIdle();
      const summary = runtime.uiCaptureResults.get(checkpoint.id);
      assert.ok(summary && !(summary instanceof Error), summary instanceof Error ? summary.message : 'no summary');
      assert.equal(summary.failed + summary.pathBroken, 0, JSON.stringify(summary));
    }
    assert.equal(checkpoints.length, 3);

    const landing = runtime.store.listUiStates().find((state) => state.route === ROUTE && state.componentSet === LANDING_SET)!;
    assert.ok(landing.components.includes(WELCOME), 'the landing page shows the welcome modal');
    for (const profile of ['mobile', 'tablet', 'desktop']) {
      const frames = runtime.store.listScreenFrames(dialogState.id, profile);
      assert.deepEqual(frames.map((frame) => frame.status), ['captured', 'captured', 'unchanged'], profile);
      const versions = runtime.store.listComponentVersions(DIALOG, profile).filter((version) => version.stateId === dialogState.id);
      assert.deepEqual(versions.map((version) => version.unchangedFrom), [undefined, undefined, checkpoints[1]!.id], profile);
      assert.notEqual(versions[0]!.cropDigest, versions[1]!.cropDigest);
      // The learned path dismissed the welcome modal before opening the dialog.
      assert.equal(runtime.store.listComponentVersions(WELCOME, profile).some((version) => version.stateId === dialogState.id), false);
    }

    // Crops are the dialog itself, in device pixels, with the edited background.
    const mobile = runtime.store.listComponentVersions(DIALOG, 'mobile').find((version) => version.stateId === dialogState.id && !version.unchangedFrom)!;
    const desktop = runtime.store.listComponentVersions(DIALOG, 'desktop').find((version) => version.stateId === dialogState.id && !version.unchangedFrom)!;
    const mobileCrop = decodePng(runtime.store.readVisual(mobile.cropDigest));
    const desktopCrop = decodePng(runtime.store.readVisual(desktop.cropDigest));
    assert.deepEqual([mobileCrop.width, mobileCrop.height], [Math.round(mobile.box.width * 2), Math.round(mobile.box.height * 2)]);
    assert.deepEqual([desktopCrop.width, desktopCrop.height], [Math.round(desktop.box.width), Math.round(desktop.box.height)]);
    const pixel = (image: ReturnType<typeof decodePng>, x: number, y: number) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
    assert.deepEqual(pixel(desktopCrop, 8, desktopCrop.height - 4), [0xfd, 0xe6, 0x8a]);
    const frame = decodePng(runtime.store.readVisual(runtime.store.listScreenFrames(dialogState.id, 'mobile')[0]!.imageDigest!));
    assert.equal(frame.width, 780, 'mobile frames render at 390 CSS px × 2');
  } finally {
    await runtime.close();
    server.kill();
    if (process.env.KEEP_UI_HISTORY_FIXTURE) console.log(root, output);
    else rmSync(root, { recursive: true, force: true });
  }
});
