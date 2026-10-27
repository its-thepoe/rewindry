import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { RewindryRuntime } from '../../src/runtime.ts';
import { WorkspaceStore } from '../../src/store.ts';
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

function pngDimensions(image: Buffer): { width: number; height: number } {
  assert.equal(image.toString('ascii', 1, 4), 'PNG');
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
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
  const source = readFileSync(join(example, 'src', 'main.tsx'), 'utf8').replace(
    'return <main><h1>Rewindry preview fixture</h1><p>State A</p></main>;',
    'const screen = new URLSearchParams(window.location.search).get("screen") ?? "home";\n  if (screen === "promo") return <main data-rewindry-target="promo-screen"><h1>Promo screen</h1><p>State A</p></main>;\n  return <main data-rewindry-target="bingo-home"><h1>Rewindry preview fixture</h1><p>State A</p>{screen === "board" && <section data-rewindry-target="bingo-board"><h2>Bingo board</h2><p>25 squares</p></section>}<div data-rewindry-target="duplicate-card">Card 1</div><div data-rewindry-target="duplicate-card">Card 2</div></main>;',
  );
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
    const configPath = join(root, '.rewindry', 'config.json');
    const projectConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const previewConfig = projectConfig.preview as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({
      ...projectConfig,
      preview: {
        ...previewConfig,
        targets: [
          { id: 'bingo-home', label: 'Bingo home', route: '/', viewports: [
            { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
            { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
          ] },
          { id: 'bingo-board', label: 'Bingo board component', route: '/?screen=board', selector: '[data-rewindry-target="bingo-board"]', viewports: [
            { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
          ] },
          { id: 'promo-screen', label: 'Promo screen', route: '/?screen=promo', viewports: [
            { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
          ] },
          { id: 'missing-component', label: 'Missing component', route: '/', selector: '[data-rewindry-target="not-present"]', viewports: [
            { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
          ] },
          { id: 'duplicate-component', label: 'Duplicate component', route: '/', selector: '[data-rewindry-target="duplicate-card"]', viewports: [
            { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
          ] },
        ],
      },
    }));
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
      writeFileSync(join(root, 'src', 'main.tsx'), source.replaceAll('State A', `State ${turn === 1 ? 'B' : 'C'}`));
      await until(() => runtime!.observedWrites, (value) => value > before, `turn ${turn} write`);
      await new Promise((done) => setTimeout(done, 300));
      runtime.ingest(makeEvent('outer_turn_finished', turn));
      await until(() => runtime!.captureResults.size, (size) => size === turn, `turn ${turn} screenshot`);
      const checkpoint: Checkpoint | undefined = runtime.store.list()[turn];
      assert.ok(checkpoint);
      assert.equal(runtime.captureResults.get(checkpoint.id)?.status, 'captured');
      assert.equal(runtime.captureResults.get(checkpoint.id)?.previewReadiness, 'idle');
      const record = JSON.parse(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, 'primary.json'), 'utf8')) as {
        targets: Array<{ targetId: string; viewportId: string; route: string; selector?: string; viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean; status: string; reason?: string; imageFile?: string }>;
      };
      assert.equal(record.targets.length, 6);
      const mobileHome = record.targets.find((target) => target.targetId === 'bingo-home' && target.viewportId === 'mobile');
      const desktopHome = record.targets.find((target) => target.targetId === 'bingo-home' && target.viewportId === 'desktop');
      const board = record.targets.find((target) => target.targetId === 'bingo-board');
      const promo = record.targets.find((target) => target.targetId === 'promo-screen');
      const missing = record.targets.find((target) => target.targetId === 'missing-component');
      const duplicate = record.targets.find((target) => target.targetId === 'duplicate-component');
      assert.deepEqual(mobileHome?.viewport, { width: 390, height: 844 });
      assert.equal(mobileHome?.isMobile, true);
      assert.equal(mobileHome?.hasTouch, true);
      assert.equal(desktopHome?.status, 'captured');
      assert.equal(board?.route, '/?screen=board');
      assert.equal(board?.selector, '[data-rewindry-target="bingo-board"]');
      assert.equal(promo?.route, '/?screen=promo');
      assert.equal(promo?.status, 'captured');
      assert.equal(missing?.status, 'source_only');
      assert.match(missing?.reason ?? '', /matched 0 elements/);
      assert.equal(duplicate?.status, 'source_only');
      assert.match(duplicate?.reason ?? '', /matched 2 elements/);
      assert.deepEqual(pngDimensions(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, mobileHome!.imageFile!))), { width: 390, height: 844 });
      assert.deepEqual(pngDimensions(readFileSync(join(root, '.rewindry', 'previews', checkpoint.id, desktopHome!.imageFile!))), { width: 1280, height: 800 });
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
        const trigger = overlay.locator('.trigger');
        assert.equal(await trigger.evaluate((button) => getComputedStyle(button).opacity), '0');
        assert.equal(await trigger.evaluate((button) => getComputedStyle(button).pointerEvents), 'none');
        await page.keyboard.press('Alt+Shift+r');
        assert.equal(await overlay.locator('.timeline').isVisible(), true);
        await page.keyboard.press('Escape');
        assert.equal(await overlay.locator('.timeline').isHidden(), true);
        await page.mouse.move(viewport.width / 2, viewport.height - 34);
        await until(() => trigger.evaluate((button) => button.classList.contains('is-revealed')), Boolean, 'hover-revealed trigger');
        await trigger.click();
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
        const targetSelect = overlay.getByLabel('Screen or component');
        const viewportSelect = overlay.getByLabel('Viewport');
        assert.equal(await targetSelect.isVisible(), true);
        assert.equal(await viewportSelect.isVisible(), true);
        await targetSelect.selectOption('bingo-board');
        assert.equal(await overlay.locator('.dot').nth(1).getAttribute('aria-current'), 'step');
        await until(() => overlay.locator('.visual img').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width > 0, 'component PNG');
        assert.match(await overlay.locator('.visual img').getAttribute('src') ?? '', /bingo-board\/mobile\.png$/);
        await overlay.locator('.dot').nth(2).click();
        assert.equal(await targetSelect.inputValue(), 'bingo-board');
        await targetSelect.selectOption('missing-component');
        await until(() => overlay.locator('.missing').textContent(), (message) => /Missing component.*not captured/.test(message ?? ''), 'explicit missing component message');
        assert.equal(await overlay.locator('.missing').isVisible(), true);
        await targetSelect.selectOption('bingo-home');
        await viewportSelect.selectOption('desktop');
        await until(() => overlay.locator('.visual img').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width === 1280, 'desktop image variant');
        assert.equal(await overlay.locator('.dot.selected').getAttribute('aria-current'), 'step');
        const controlsFit = await overlay.locator('.capture-controls').evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        });
        assert.equal(controlsFit, true);
        await overlay.locator('.dot').nth(1).click();
        assert.equal(await targetSelect.inputValue(), 'bingo-home');
        assert.equal(await viewportSelect.inputValue(), 'desktop');
        assert.equal(await overlay.locator('.dot').nth(1).getAttribute('aria-current'), 'step');
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
      const touchPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await touchPage.goto(previewUrl, { waitUntil: 'networkidle' });
      await touchPage.touchscreen.tap(195, 810);
      await until(() => touchPage.locator('#rewindry-overlay-root .timeline').isVisible(), Boolean, 'touch-opened timeline');
      await touchPage.close();

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
      await longHistory.keyboard.press('Alt+Shift+r');
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
      const viewerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await viewerPage.goto(viewerUrl, { waitUntil: 'networkidle' });
      await until(() => viewerPage.locator('#git-summary').textContent(), (label) => /1 commits/.test(label ?? ''), 'Git index');
      assert.equal(await viewerPage.locator('#git-progress').isHidden(), true);
      await viewerPage.locator('#git-summary').click();
      assert.equal(await viewerPage.locator('#git-list li').count(), 1);
      assert.match(await viewerPage.locator('#git-list').textContent() ?? '', /Initial fixture/);
      assert.equal(await viewerPage.locator('#timeline .point-button').count(), 4);
      await viewerPage.locator('#timeline .point-button').nth(2).click();
      await until(() => viewerPage.locator('#timeline .point-button.is-selected').evaluate((dot) => {
        const marker = getComputedStyle(dot, '::before');
        return [marker.width, marker.height, marker.backgroundColor];
      }), (marker) => marker[0] === '24px' && marker[2] === 'rgb(23, 25, 26)', 'selected iteration marker');
      const standaloneTarget = viewerPage.getByLabel('Screen or component');
      const standaloneViewport = viewerPage.getByLabel('Viewport');
      assert.equal(await standaloneTarget.isVisible(), true);
      await standaloneTarget.selectOption('bingo-board');
      assert.equal(await viewerPage.locator('#timeline .point-button.is-selected').count(), 1);
      await viewerPage.locator('#timeline .point-button').nth(1).click();
      assert.equal(await standaloneTarget.inputValue(), 'bingo-board');
      await standaloneTarget.selectOption('missing-component');
      await until(() => viewerPage.locator('#visual-message').textContent(), (message) => /Missing component.*not captured/.test(message ?? ''), 'standalone missing target message');
      const standaloneControlsFit = await viewerPage.locator('#capture-controls').evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      });
      assert.equal(standaloneControlsFit, true);
      assert.equal(await viewerPage.locator('#timeline .point-button').nth(1).getAttribute('aria-current'), 'step');
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
    writeFileSync(join(root, 'src', 'main.tsx'), source.replaceAll('State A', 'State D'));
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

    const beforeBrokenWrite = await (await fetch(`${previewUrl}__rewindry/preview`)).json() as { generation: number };
    writeFileSync(join(root, 'src', 'main.tsx'), 'export const broken = ;');
    await until(async () => (await fetch(`${previewUrl}__rewindry/preview`)).json() as Promise<{ generation: number }>,
      (identity) => identity.generation > beforeBrokenWrite.generation, 'broken source generation');
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

test('explicit backfill replays saved checkpoints into labeled historical visuals', { timeout: 120_000 }, async () => {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-backfill-e2e-'));
  const fixtureSource = readFileSync(join(example, 'src', 'main.tsx'), 'utf8');
  assert.match(fixtureSource, /State A/);
  mkdirSync(join(root, 'src'));
  for (const name of ['index.html', 'package.json']) cpSync(join(example, name), join(root, name));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  const originalConfig = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`;
  writeFileSync(join(root, 'vite.config.ts'), originalConfig);
  writeFileSync(join(root, 'src', 'main.tsx'), fixtureSource);
  const store = new WorkspaceStore(root);
  store.initialize();
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({
    preview: {
      appId: 'rewindry-backfille2e',
      targets: [{ id: 'home', label: 'Home', route: '/', viewports: [
        { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
        { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
      ] }],
    },
  }));
  const live = store.snapshot('baseline');
  assert.ok(live);
  writeFileSync(join(root, 'src', 'main.tsx'), fixtureSource.replaceAll('State A', 'State B'));
  const unseen = store.snapshot('unattributed_group');
  assert.ok(unseen);
  writeFileSync(join(root, 'src', 'main.tsx'), 'export const broken = ;');
  const broken = store.snapshot('unattributed_group');
  assert.ok(broken);
  writeFileSync(join(root, 'src', 'main.tsx'), fixtureSource.replaceAll('State A', 'Current work'));

  const legacyPrimary = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const liveDirectory = join(root, '.rewindry', 'previews', live.id);
  mkdirSync(liveDirectory, { recursive: true });
  writeFileSync(join(liveDirectory, 'primary.png'), legacyPrimary);
  writeFileSync(join(liveDirectory, 'primary.json'), JSON.stringify({
    checkpointId: live.id, status: 'captured', sourceDigest: live.digest, appId: 'rewindry-backfille2e',
    route: '/', viewport: { width: 1280, height: 800 }, fidelityLimits: [],
  }));
  const historyBefore = store.list().map(({ id, digest, createdAt }) => ({ id, digest, createdAt }));

  const refused = spawn(process.execPath, [resolve('dist/cli.js'), 'backfill', '--root', root], { stdio: 'ignore' });
  assert.equal(await new Promise<number | null>((done) => refused.once('exit', done)), 1);
  assert.equal(existsSync(join(root, '.rewindry', 'previews', unseen.id)), false);

  let output = '';
  const backfill = spawn(process.execPath, [resolve('dist/cli.js'), 'backfill', '--run-historical-source', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [backfill.stdout, backfill.stderr]) stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  assert.equal(await new Promise<number | null>((done) => backfill.once('exit', done)), 0, output);
  assert.match(output, /Backfill complete: 2 captured, 0 partial, 1 unavailable\./);

  assert.deepEqual(store.list().map(({ id, digest, createdAt }) => ({ id, digest, createdAt })), historyBefore);
  assert.deepEqual(readdirSync(join(root, '.rewindry', 'tmp')), []);
  assert.match(readFileSync(join(root, 'src', 'main.tsx'), 'utf8'), /Current work/);
  type Target = { targetId: string; viewportId: string; status: string; imageFile?: string; captureMode?: string; replayedAt?: string; reason?: string };
  const recordOf = (id: string) => JSON.parse(readFileSync(join(root, '.rewindry', 'previews', id, 'primary.json'), 'utf8')) as { status: string; targets: Target[] };

  const liveRecord = recordOf(live.id);
  assert.deepEqual(readFileSync(join(liveDirectory, 'primary.png')), legacyPrimary);
  assert.equal(liveRecord.targets.find((target) => target.targetId === 'default')?.captureMode, undefined);
  const liveMobile = liveRecord.targets.find((target) => target.targetId === 'home' && target.viewportId === 'mobile');
  assert.equal(liveMobile?.captureMode, 'replayed');
  assert.match(liveMobile?.replayedAt ?? '', /^\d{4}-/);
  assert.equal(liveMobile?.imageFile, 'home--mobile.png');
  assert.deepEqual(pngDimensions(readFileSync(join(liveDirectory, 'home--mobile.png'))), { width: 390, height: 844 });

  const unseenRecord = recordOf(unseen.id);
  assert.equal(unseenRecord.status, 'captured');
  const unseenMobile = unseenRecord.targets.find((target) => target.viewportId === 'mobile');
  assert.equal(unseenMobile?.imageFile, 'primary.png');
  assert.equal(unseenMobile?.captureMode, 'replayed');
  const unseenImage = readFileSync(join(root, '.rewindry', 'previews', unseen.id, 'primary.png'));
  assert.deepEqual(pngDimensions(unseenImage), { width: 390, height: 844 });
  const digest = (image: Buffer) => createHash('sha256').update(image).digest('hex');
  assert.notEqual(digest(readFileSync(join(liveDirectory, 'home--mobile.png'))), digest(unseenImage));

  const brokenRecord = recordOf(broken.id);
  assert.equal(brokenRecord.status, 'source_only');
  assert.ok(brokenRecord.targets.every((target) => target.status === 'source_only' && target.reason));

  assert.equal(installViteIntegration(root, resolve('.')), 'installed');
  const vitePort = await port();
  const previewUrl = `http://127.0.0.1:${vitePort}/`;
  let viteOutput = '';
  const devServer = spawn(process.execPath, [join(example, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [devServer.stdout, devServer.stderr]) stream.on('data', (chunk: Buffer) => { viteOutput = `${viteOutput}${chunk.toString()}`.slice(-8_000); });
  const viewer = new ViewerServer(root, store);
  const browser = await chromium.launch({ headless: true });
  try {
    await until(async () => (await fetch(`${previewUrl}__rewindry/preview`)).ok, Boolean, 'Vite preview', () => viteOutput);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    const overlay = page.locator('#rewindry-overlay-root');
    await page.keyboard.press('Alt+Shift+r');
    await until(() => overlay.locator('.dot').count(), (count) => count === 4, 'backfilled overlay dots');
    const replayNote = overlay.locator('.replay-note');
    await overlay.locator('.dot').nth(0).click();
    const overlayTarget = overlay.getByLabel('Screen or component');
    await overlayTarget.selectOption('default');
    await until(() => overlay.locator('.visual img').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width === 1, 'preserved live primary');
    assert.equal(await replayNote.isHidden(), true);
    await overlayTarget.selectOption('home');
    await until(() => overlay.locator('.visual img').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width === 390, 'replayed sibling variant');
    assert.equal(await replayNote.isVisible(), true);
    assert.match(await replayNote.textContent() ?? '', /Replayed from saved source/);
    assert.equal(await replayNote.evaluate((note) => { const box = note.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true);
    await overlay.locator('.dot').nth(1).click();
    await until(() => replayNote.isVisible(), Boolean, 'overlay replay label on replayed primary');
    await overlay.locator('.dot').nth(2).click();
    await until(() => overlay.locator('.missing').isVisible(), Boolean, 'failed replay stays source-only');
    assert.equal(await replayNote.isHidden(), true);
    assert.equal(await overlay.locator('.dot').nth(2).getAttribute('aria-current'), 'step');
    await page.close();

    const viewerPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await viewerPage.goto(await viewer.start(), { waitUntil: 'networkidle' });
    await until(() => viewerPage.locator('#timeline .point-button').count(), (count) => count === 4, 'standalone backfilled points');
    const standaloneNote = viewerPage.locator('#replay-note');
    const standaloneTarget = viewerPage.getByLabel('Screen or component');
    await viewerPage.locator('#timeline .point-button').nth(0).click();
    await standaloneTarget.selectOption('default');
    await until(() => viewerPage.locator('#visual-image').evaluate((image: HTMLImageElement) => image.naturalWidth), (width) => width === 1, 'standalone preserved primary');
    assert.equal(await standaloneNote.isHidden(), true);
    await standaloneTarget.selectOption('home');
    await until(() => standaloneNote.isVisible(), Boolean, 'standalone replay label');
    assert.match(await standaloneNote.textContent() ?? '', /Replayed from saved source/);
    await viewerPage.locator('#timeline .point-button').nth(2).click();
    await until(() => viewerPage.locator('#visual-message').textContent(), (message) => /not captured/.test(message ?? ''), 'standalone failed replay message');
    assert.equal(await standaloneNote.isHidden(), true);
    await viewerPage.close();
  } finally {
    await browser.close();
    await viewer.close();
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
