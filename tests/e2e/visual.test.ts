import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { RewindryRuntime } from '../../src/runtime.ts';
import { captureCheckpoint } from '../../src/capture.ts';
import type { Checkpoint } from '../../src/store.ts';
import type { AgentEvent } from '../../src/turn-manager.ts';
import { installViteIntegration, uninstallViteIntegration } from '../../src/vite-install.ts';
import { ViewerServer } from '../../src/api.ts';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function until<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  label: string,
  details = () => '',
): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch { /* The dev server may still be starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  const extraDetails = details();
  throw new Error(`Timed out waiting for ${label}${extraDetails ? `\n${extraDetails}` : ''}`);
}

test('live turns and one offline retry keep distinct historical screenshots', { timeout: 60_000 }, async () => {
  assert.match(readFileSync(resolve('dist/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.equal(statSync(resolve('dist/cli.js')).mode & 0o111, 0o111);
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-visual-'));
  const source = readFileSync(join(example, 'src', 'main.tsx'), 'utf8');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.rewindry'));
  for (const name of ['index.html', 'package.json']) cpSync(join(example, name), join(root, name));
  writeFileSync(join(root, 'src', 'main.tsx'), source);
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  const originalConfig = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`;
  writeFileSync(join(root, 'vite.config.ts'), originalConfig);
  assert.equal(installViteIntegration(root, resolve('.')), 'installed');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Rewindry Test'],
    ['config', 'user.email', 'test@example.invalid'],
    ['add', 'index.html', 'package.json', 'src/main.tsx', 'vite.config.ts'],
    ['commit', '-qm', 'Initial fixture'],
  ]) execFileSync('git', ['-C', root, ...args]);
  const vitePort = await port();
  const viteBin = join(example, 'node_modules', 'vite', 'bin', 'vite.js');
  let viteOutput = '';
  const startVite = () => {
    const child = spawn(
      process.execPath,
      [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        viteOutput = `${viteOutput}${chunk.toString()}`.slice(-8_000);
      });
    }
    return child;
  };
  let devServer = startVite();
  const previewUrl = `http://127.0.0.1:${vitePort}/`;
  const viteDiagnostics = () => `Vite exit=${devServer.exitCode ?? 'running'} signal=${devServer.signalCode ?? 'none'}\n${viteOutput}`;
  let runtime: RewindryRuntime | undefined;
  let viewer: ViewerServer | undefined;
  try {
    await until(async () => (await fetch(`${previewUrl}__rewindry/preview`)).ok, Boolean, 'Vite preview', viteDiagnostics);
    const registered = await until(() => {
      const config = JSON.parse(readFileSync(join(root, '.rewindry', 'config.json'), 'utf8')) as { preview?: { url?: string; appId?: string } };
      return config.preview;
    }, (preview) => Boolean(preview?.url), 'automatic preview URL');
    assert.equal(registered?.url, previewUrl);
    assert.match(registered?.appId ?? '', /^rewindry-[a-f0-9]{12}$/);
    runtime = new RewindryRuntime(root, {
      settleMs: 500, manualQuietMs: 1_000, rescanIntervalMs: 100,
    });
    await runtime.start();
    const makeEvent = (eventType: AgentEvent['eventType'], turn: number): AgentEvent => ({
      protocolVersion: 1,
      eventId: `${turn}-${eventType}`,
      eventType,
      provider: 'cursor',
      adapterVersion: 'e2e-fixture',
      occurredAt: new Date().toISOString(),
      workspaceId: runtime!.workspaceId,
      hostSessionId: 'session',
      hostTurnId: `turn-${turn}`,
      status: eventType === 'outer_turn_finished' ? 'completed' : undefined,
      boundaryQuality: 'paired',
    });
    const images: Buffer[] = [];
    for (const turn of [1, 2]) {
      runtime.ingest(makeEvent('outer_turn_started', turn));
      const before = runtime.observedWrites;
      writeFileSync(join(root, 'src', 'main.tsx'), source.replace('State A', `State ${turn === 1 ? 'B' : 'C'}`));
      await until(() => runtime!.observedWrites, (value) => value > before, `turn ${turn} write`);
      await new Promise((done) => setTimeout(done, 300));
      runtime.ingest(makeEvent('outer_turn_finished', turn));
      await until(() => runtime!.captureResults.size, (size) => size === turn, `turn ${turn} screenshot`);
      const checkpoint: Checkpoint | undefined = runtime.store.list()[turn];
      assert.ok(checkpoint);
      assert.equal(runtime.captureResults.get(checkpoint.id)?.status, 'captured');
      assert.equal(runtime.captureResults.get(checkpoint.id)?.previewReadiness, 'idle');
      images.push(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, 'primary.png')));
      assert.equal(runtime.store.readFile(checkpoint.id, 'src/main.tsx').toString().includes(`State ${turn === 1 ? 'B' : 'C'}`), true);
    }
    assert.equal(runtime.store.list().length, 3);
    assert.notEqual(createHash('sha256').update(images[0]!).digest('hex'), createHash('sha256').update(images[1]!).digest('hex'));
    assert.deepEqual(readFileSync(join(root, '.rewindry', 'previews', runtime.store.list()[1]!.id, 'primary.png')), images[0]);

    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport });
        await page.goto(previewUrl, { waitUntil: 'networkidle' });
        const overlay = page.locator('#rewindry-overlay-root');
        await overlay.locator('.trigger').click();
        await until(() => overlay.locator('.dot').count(), (count) => count === 4, 'in-preview iteration dots');
        await overlay.locator('.dot').nth(0).click();
        assert.equal(await overlay.locator('.missing').isVisible(), true);
        await overlay.locator('.dot').nth(1).click();
        await until(() => overlay.locator('.peek').isHidden(), Boolean, 'selection peek to close');
        assert.deepEqual(await overlay.locator('.dot.selected').evaluate((dot) => {
          const marker = getComputedStyle(dot, '::after');
          return [marker.width, marker.height, marker.backgroundColor];
        }), ['24px', '6px', 'rgb(23, 25, 26)']);
        assert.equal(await overlay.locator('.dot.source-only').count(), 1);
        await until(() => overlay.locator('.visual img').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width > 0, 'historical PNG');
        assert.match(await overlay.locator('.visual img').getAttribute('src') ?? '', /__rewindry\/image\//);
        await overlay.locator('.dot').nth(2).hover();
        assert.equal(await overlay.locator('.peek').isVisible(), true);
        assert.equal(await overlay.locator('.peek img').isVisible(), true);
        await overlay.locator('.play').click();
        assert.equal(await overlay.locator('.play').getAttribute('aria-label'), 'Pause history');
        await overlay.locator('.play').click();
        assert.equal(await overlay.locator('.play').getAttribute('aria-label'), 'Play history');
        await page.keyboard.press('End');
        assert.equal(await overlay.locator('.review').isVisible(), false);
        assert.equal(await overlay.locator('.dot.live').getAttribute('aria-current'), 'step');
        const fits = await overlay.locator('.timeline').evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        });
        assert.equal(fits, true);
        await page.close();
      }
      const longHistory = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const checkpoints = Array.from({ length: 1_000 }, (_, index) => ({
        id: `point-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        previewStatus: 'source_only',
      }));
      await longHistory.route('**/__rewindry/iterations', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checkpoints }),
      }));
      await longHistory.goto(previewUrl, { waitUntil: 'networkidle' });
      const overlay = longHistory.locator('#rewindry-overlay-root');
      await overlay.locator('.trigger').click();
      await until(() => overlay.locator('.dot').count(), (count) => count === 1_001, 'long timeline');
      await longHistory.keyboard.press('Home');
      assert.equal(await overlay.locator('.dot').first().getAttribute('aria-current'), 'step');
      assert.equal(await overlay.locator('.missing').isVisible(), true);
      await longHistory.keyboard.press('End');
      assert.equal(await overlay.locator('.dot').last().getAttribute('aria-current'), 'step');
      assert.equal(await overlay.locator('.dots').evaluate((dots) => dots.scrollLeft > 0), true);
      await longHistory.close();

      viewer = new ViewerServer(root, runtime.store, previewUrl);
      const viewerUrl = await viewer.start();
      const viewerPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await viewerPage.goto(viewerUrl, { waitUntil: 'networkidle' });
      await until(() => viewerPage.locator('#git-summary').textContent(), (label) => /1 commits/.test(label ?? ''), 'Git index');
      assert.equal(await viewerPage.locator('#git-progress').isHidden(), true);
      await viewerPage.locator('#git-summary').click();
      assert.equal(await viewerPage.locator('#git-list li').count(), 1);
      assert.match(await viewerPage.locator('#git-list').textContent() ?? '', /Initial fixture/);
      assert.equal(await viewerPage.locator('#timeline .point-button').count(), 4);
      assert.deepEqual(await viewerPage.locator('#timeline .point-button.is-selected').evaluate((dot) => {
        const marker = getComputedStyle(dot, '::before');
        return [marker.width, marker.height, marker.backgroundColor];
      }), ['24px', '6px', 'rgb(23, 25, 26)']);
      await viewerPage.close();
    } finally {
      await browser.close();
    }

    const build = spawn(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'ignore' });
    const buildCode = await new Promise<number | null>((done) => build.once('exit', done));
    assert.equal(buildCode, 0);
    const productionFiles = [
      readFileSync(join(root, 'dist', 'index.html'), 'utf8'),
      ...readdirSync(join(root, 'dist', 'assets')).map((name) => readFileSync(join(root, 'dist', 'assets', name), 'utf8')),
    ].join('\n');
    assert.doesNotMatch(productionFiles, /__rewindry|rewindry-overlay-root|Rewindry timeline/);

    devServer.kill('SIGTERM');
    await new Promise<void>((done) => devServer.once('exit', () => done()));
    runtime.ingest(makeEvent('outer_turn_started', 3));
    const beforeOfflineWrite = runtime.observedWrites;
    writeFileSync(join(root, 'src', 'main.tsx'), source.replace('State A', 'State D'));
    await until(() => runtime!.observedWrites, (value) => value > beforeOfflineWrite, 'offline turn write');
    runtime.ingest(makeEvent('outer_turn_finished', 3));
    await until(() => runtime!.captureResults.size, (size) => size === 3, 'offline source-only record');
    const offline = runtime.store.list().at(-1);
    assert.ok(offline);
    assert.equal(runtime.captureResults.get(offline.id)?.status, 'source_only');
    assert.equal(runtime.captureResults.get(offline.id)?.attempts, 1);
    viteOutput = '';
    devServer = startVite();
    await until(async () => (await fetch(`${previewUrl}__rewindry/preview`)).ok, Boolean, 'restarted Vite preview', viteDiagnostics);
    const retried = await until(() => JSON.parse(readFileSync(join(root, '.rewindry', 'previews', offline.id, 'primary.json'), 'utf8')) as {
      status: string; attempts: number;
    }, (record) => record.status === 'captured', 'automatic source-only retry');
    assert.equal(retried.attempts, 2);

    writeFileSync(join(root, 'src', 'main.tsx'), 'export const broken = ;');
    const broken = runtime.store.snapshot('unattributed_group');
    assert.ok(broken);
    const compilerFailure = await captureCheckpoint(root, runtime.store, broken, {
      previewUrl, appId: registered!.appId!,
    });
    assert.equal(compilerFailure.status, 'source_only');
    assert.match(compilerFailure.reason ?? '', /compiler error|Preview page error|HTTP 500/i);
  } finally {
    await viewer?.close();
    await runtime?.close();
    devServer.kill('SIGTERM');
    await new Promise<void>((done) => {
      if (devServer.exitCode !== null) return done();
      devServer.once('exit', () => done());
    });
    assert.equal(uninstallViteIntegration(root), true);
    assert.equal(readFileSync(join(root, 'vite.config.ts'), 'utf8'), originalConfig);
    rmSync(root, { recursive: true, force: true });
  }
});
