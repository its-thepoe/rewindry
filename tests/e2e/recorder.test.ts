import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { WorkspaceStore, type UiState } from '../../src/store.ts';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function until<T>(read: () => T, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const DIALOG = 'src/attribution/ItemDialog.tsx#ItemDialog';

test('ordinary use in a browser with the widget hidden teaches Rewindry how to reach a portaled dialog', { timeout: 90_000 }, async () => {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-recorder-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  for (const name of ['attribution.html', 'package.json']) cpSync(join(example, name), join(root, name));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'vite.config.ts'), [
    `import { defineConfig } from 'vite';`,
    `import react from '@vitejs/plugin-react';`,
    `import { rewindryPreviewPlugin } from ${JSON.stringify(resolve('src/vite-plugin.ts'))};`,
    `export default defineConfig({ plugins: [react(), rewindryPreviewPlugin('recorder-e2e')], cacheDir: '.vite-cache' });`,
  ].join('\n'));
  const store = new WorkspaceStore(root);
  store.initialize();
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { widget: false } }));
  const states = () => store.listUiStates();

  const vitePort = await port();
  let output = '';
  const server = spawn(process.execPath, [join(example, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4_000); });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const base = `http://127.0.0.1:${vitePort}/attribution.html`;
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { await page.goto(base); break; } catch (error) {
        if (Date.now() > deadline) throw new Error(`Vite did not start\n${output}`, { cause: error });
        await new Promise((done) => setTimeout(done, 150));
      }
    }
    // The page is unchanged except for the recorder: no widget is mounted.
    await page.locator('script[data-rewindry-recorder]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#rewindry-overlay-root').count(), 0);
    assert.equal(await page.locator('script[data-rewindry-preview]').count(), 0);

    const [home] = await until(states, (value) => value.length === 1, 'the landing state');
    assert.equal(home!.route, '/attribution.html');
    assert.deepEqual(home!.path, []);
    assert.ok(home!.components.includes('src/attribution/Board.tsx#Board'));
    assert.ok(home!.modules.includes('src/attribution/Cell.tsx'), JSON.stringify(home!.modules));

    // Typing never reaches the store, even in a field the user clicked.
    await page.getByRole('textbox', { name: 'Search' }).click();
    await page.keyboard.type('secret-note-4711');
    await page.getByRole('button', { name: 'Item 2' }).click();
    const dialog = (await until(states, (value) => value.some((state) => state.components.includes(DIALOG)), 'the dialog state'))
      .find((state) => state.components.includes(DIALOG))!;
    assert.equal(dialog.route, '/attribution.html');
    const path = dialog.path as { action: string; target: { by: string; role?: string; name?: string }[] }[];
    assert.deepEqual(path.map((step) => step.action), ['click', 'click']);
    assert.deepEqual(path[1]!.target[0], { by: 'role', role: 'button', name: 'Item 2', index: 0 });
    assert.deepEqual(path[0]!.target[0], { by: 'role', role: 'textbox', name: 'Search', index: 0 });

    // A shorter route to the same screen replaces the longer path.
    // Reports are fully read, so a page with the recorder still reaches network idle.
    await page.goto(base, { waitUntil: 'networkidle', timeout: 10_000 });
    assert.equal(states().length, 2, 'reloading a known state adds nothing');
    await page.getByRole('button', { name: 'Item 2' }).click();
    await until(states, (value) => (value.find((state) => state.id === dialog.id)?.path.length ?? 0) === 1, 'the shortest dialog path');
    assert.equal(states().length, 2);

    // A URL change starts a new state that replays by loading that URL directly.
    await page.goto(`${base}?screen=profile`);
    const profile = (await until(states, (value) => value.some((state) => state.route === '/attribution.html?screen=profile'), 'the profile state'))
      .find((state) => state.route === '/attribution.html?screen=profile')!;
    assert.deepEqual(profile.path, []);

    // Rewindry's own capture browser never teaches itself.
    const capture = await browser.newContext();
    await capture.addInitScript(() => { (globalThis as { __rewindryCapture?: boolean }).__rewindryCapture = true; });
    const capturePage = await capture.newPage();
    await capturePage.goto(base);
    await capturePage.getByRole('button', { name: 'Item 3' }).click();
    await capturePage.getByRole('dialog', { name: 'Item 3' }).waitFor();
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(states().length, 3);
    await capture.close();

    // A stored path is replayable: following its first locator in a fresh page reaches the dialog.
    const replay = await browser.newPage();
    await replay.goto(base);
    const stored = states().find((state: UiState) => state.id === dialog.id)!.path as { target: { role: string; name: string; index: number }[] }[];
    await replay.getByRole(stored[0]!.target[0]!.role as 'button', { name: stored[0]!.target[0]!.name, exact: true }).nth(stored[0]!.target[0]!.index).click();
    await replay.getByRole('dialog', { name: 'Item 2' }).waitFor();

    const database = readdirSync(join(root, '.rewindry')).filter((name) => name.startsWith('index.sqlite'))
      .map((name) => readFileSync(join(root, '.rewindry', name)).toString('latin1')).join('');
    assert.equal(database.includes('secret-note-4711'), false);
  } finally {
    await browser.close();
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
