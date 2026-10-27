import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { collectComponentMap, type ComponentMap } from '../../src/component-map.ts';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

const example = resolve('examples/vite-react');
const VITE = join(example, 'node_modules', 'vite', 'bin', 'vite.js');
// A plain React config: attribution must not depend on any Rewindry build transform.
// A private cache keeps every run cold and independent of other tests sharing node_modules.
const CONFIG = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], cacheDir: '.vite-cache' });\n`;

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-attribution-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  for (const name of ['attribution.html', 'package.json', 'tsconfig.json']) cpSync(join(example, name), join(root, name));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  cpSync(join(example, 'attribution.html'), join(root, 'index.html'));
  writeFileSync(join(root, 'vite.config.ts'), CONFIG);
  return root;
}

const keys = (map: ComponentMap) => map.components.map((item) => `${item.key}:${item.occurrence}`);

test('React 19 dev pages attribute repeated, portal and shared components to source files', { timeout: 60_000 }, async () => {
  const root = fixtureRoot();
  const vitePort = await port();
  let output = '';
  const server = spawn(process.execPath, [VITE, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.getByRole('button', { name: 'Item 3' }).waitFor();

    const home = await collectComponentMap(page);
    assert.equal(home.reason, undefined);
    assert.deepEqual(keys(home), [
      'src/attribution/main.tsx#App:0',
      'src/attribution/Header.tsx#Header:0',
      'src/attribution/Badge.tsx#Badge:0',
      'src/attribution/Board.tsx#Board:0',
      'src/attribution/Cell.tsx#Cell:0',
      'src/attribution/Cell.tsx#Cell:1',
      'src/attribution/Cell.tsx#Cell:2',
    ]);
    for (const item of home.components) assert.ok(item.box.width > 0 && item.box.height > 0, item.key);
    const cells = home.components.filter((item) => item.component === 'Cell');
    const third = await page.getByRole('button', { name: 'Item 3' }).boundingBox();
    assert.ok(third);
    assert.deepEqual(cells[2]!.box, { x: third.x, y: third.y, width: third.width, height: third.height });

    // The dialog is portaled to <body>, outside the React root's DOM subtree.
    await page.getByRole('button', { name: 'Item 2' }).click();
    const dialogElement = page.getByRole('dialog', { name: 'Item 2' });
    await dialogElement.waitFor();
    const withDialog = await collectComponentMap(page);
    const dialog = withDialog.components.find((item) => item.key === 'src/attribution/ItemDialog.tsx#ItemDialog');
    const dialogBox = await dialogElement.boundingBox();
    assert.ok(dialog && dialogBox);
    assert.deepEqual(dialog.box, { x: dialogBox.x, y: dialogBox.y, width: dialogBox.width, height: dialogBox.height });

    // The same component attributes identically on a second route.
    await page.goto(`${base}?screen=profile`);
    await page.getByRole('heading', { name: 'Profile' }).waitFor();
    const profile = await collectComponentMap(page);
    assert.deepEqual(keys(profile), [
      'src/attribution/main.tsx#App:0',
      'src/attribution/Header.tsx#Header:0',
      'src/attribution/Badge.tsx#Badge:0',
    ]);
    for (const map of [home, withDialog, profile]) assert.equal(map.unattributed, 0);
  } finally {
    await browser.close();
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production builds of the fixture contain no attribution code', { timeout: 60_000 }, async () => {
  const root = fixtureRoot();
  try {
    const build = spawn(process.execPath, [VITE, 'build', '--outDir', 'dist', '--emptyOutDir'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [build.stdout, build.stderr]) stream.on('data', (chunk: Buffer) => { output += chunk; });
    assert.equal(await new Promise<number | null>((done) => build.once('exit', done)), 0, output);
    const assets = readdirSync(join(root, 'dist', 'assets')).filter((name) => name.endsWith('.js'));
    assert.ok(assets.length);
    for (const name of assets) {
      const code = readFileSync(join(root, 'dist', 'assets', name), 'utf8');
      // Rewindry injects nothing, and React's dev-only owner stacks that attribution reads are absent.
      for (const marker of ['_debugStack', 'react-stack-top-frame', 'rewindry']) {
        assert.equal(code.includes(marker), false, `${name} contains ${marker}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
