import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { LocalDaemon } from '../../dist/daemon.js';
import { installHookConfigs, uninstallHookConfigs } from '../../dist/hooks.js';
import { installViteIntegration, uninstallViteIntegration } from '../../dist/vite-install.js';

async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  return address.port;
}

async function until(read, accept, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch { /* Starting services can take a moment. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const root = realpathSync(mkdtempSync(join(resolve('tests/probes'), 'codex-vite-')));
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'rewindry-vite-daemon-')));
const example = resolve('examples/vite-react');
const source = readFileSync(join(example, 'src', 'main.tsx'), 'utf8');
const originalConfig = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`;
const vitePort = await port();
const previewUrl = `http://127.0.0.1:${vitePort}/`;
let daemon;
let vite;
let browser;
try {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.rewindry'));
  for (const name of ['index.html', 'package.json']) cpSync(join(example, name), join(root, name));
  writeFileSync(join(root, 'src', 'main.tsx'), source);
  writeFileSync(join(root, 'vite.config.ts'), originalConfig);
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  assert.equal(installViteIntegration(root, resolve('.')), 'installed');
  installHookConfigs(root, resolve('dist/cli.js'), process.execPath, dataDir, ['codex-cli']);
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();
  const viteBin = join(example, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: root, stdio: 'ignore' });
  await until(async () => (await fetch(`${previewUrl}__rewindry/preview`)).ok, Boolean, 'Vite');
  await until(() => JSON.parse(readFileSync(join(root, '.rewindry', 'config.json'), 'utf8')).preview?.url,
    (url) => url === previewUrl, 'registered preview URL');

  const args = ['exec', '--ephemeral', '--disable', 'plugins', '--disable', 'apps',
    '-m', 'gpt-5.6-sol', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-C', root,
    'In src/main.tsx, change only the displayed text State A to State B. Do not edit any other file.'];
  const agent = spawn(process.env.CODEX_BIN || 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  agent.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => agent.kill('SIGTERM'), 120_000);
  const code = await new Promise((done) => agent.once('exit', done));
  clearTimeout(deadline);
  assert.equal(code, 0, stderr.split('\n').filter((line) => /error:|ERROR|failed/i.test(line)).slice(0, 10).join('\n'));
  const checkpoints = await until(() => daemon.runtime.store.list(), (list) => list.length === 2, 'confirmed turn');
  const turn = checkpoints[1];
  assert.equal(turn.kind, 'agent_turn');
  assert.equal(daemon.runtime.store.readFile(turn.id, 'src/main.tsx').toString('utf8'), source.replace('State A', 'State B'));
  const imageRecord = await until(() => JSON.parse(readFileSync(join(root, '.rewindry', 'previews', turn.id, 'primary.json'), 'utf8')),
    (record) => record.status === 'captured', 'captured visual');
  assert.equal(imageRecord.attempts, 1);
  const proof = '/tmp/rewindry-codex-vite-proof.png';
  copyFileSync(join(root, '.rewindry', 'previews', turn.id, 'primary.png'), proof);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(previewUrl, { waitUntil: 'networkidle' });
  assert.match(await page.locator('body').textContent(), /State B/);
  const overlay = page.locator('#rewindry-overlay-root');
  await overlay.locator('.trigger').click();
  await until(() => overlay.locator('.dot').count(), (count) => count === 3, 'embedded timeline');
  await overlay.locator('.dot').nth(1).click();
  await until(() => overlay.locator('.visual img').evaluate((image) => image.naturalWidth), (width) => width > 0, 'historical visual');
  console.log(JSON.stringify({ agent: 'Codex CLI 0.144.4', checkpoint: turn.kind,
    preview: imageRecord.status, readiness: imageRecord.previewReadiness, dots: 3, proof }, null, 2));
  await page.close();
} finally {
  await browser?.close();
  if (vite) {
    vite.kill('SIGTERM');
    await new Promise((done) => vite.exitCode !== null ? done() : vite.once('exit', done));
  }
  await daemon?.close();
  if (existsSync(join(dataDir, 'hooks.json'))) uninstallHookConfigs(root, dataDir);
  if (existsSync(join(root, '.rewindry', 'vite-integration.json'))) uninstallViteIntegration(root);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}
