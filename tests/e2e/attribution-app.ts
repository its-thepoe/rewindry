import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../../src/store.ts';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

export type AttributionApp = { root: string; store: WorkspaceStore; previewUrl: string; appId: string; close(): Promise<void> };

// The attribution fixture as a Rewindry project, served by the Vite and React found in `nodeModules`.
// Vite's cache lives in the temporary project and its config loads in memory, so a borrowed node_modules is only read.
export async function startAttributionApp(nodeModules: string, appId: string, route: string): Promise<AttributionApp> {
  const example = resolve('examples/vite-react');
  const root = mkdtempSync(join(tmpdir(), 'rewindry-attribution-app-'));
  cpSync(join(example, 'src', 'attribution'), join(root, 'src', 'attribution'), { recursive: true });
  cpSync(join(example, 'attribution.html'), join(root, 'index.html'));
  cpSync(join(example, 'package.json'), join(root, 'package.json'));
  symlinkSync(nodeModules, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'vite.config.ts'), [
    `import { defineConfig } from 'vite';`,
    `import react from '@vitejs/plugin-react';`,
    `import { rewindryPreviewPlugin } from ${JSON.stringify(resolve('src/vite-plugin.ts'))};`,
    `export default defineConfig({ plugins: [react(), rewindryPreviewPlugin(${JSON.stringify(appId)}, { widget: false })], cacheDir: '.vite-cache' });`,
  ].join('\n'));
  const store = new WorkspaceStore(root);
  store.initialize();
  writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ preview: { appId, route } }));
  const vitePort = await port();
  let output = '';
  // The runner config loader evaluates vite.config.ts in memory instead of writing node_modules/.vite-temp.
  const server: ChildProcess = spawn(process.execPath, [join(nodeModules, 'vite', 'bin', 'vite.js'), '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout!, server.stderr!]) stream.on('data', (chunk: Buffer) => { output = `${output}${chunk}`.slice(-4_000); });
  const previewUrl = `http://127.0.0.1:${vitePort}/`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(new URL('/__rewindry/preview', previewUrl));
      if (response.ok) break;
    } catch { /* Starting. */ }
    if (Date.now() > deadline) throw new Error(`Vite did not start\n${output}`);
    await new Promise((done) => setTimeout(done, 150));
  }
  // Warm the dependency optimizer so the first capture does not race a reload.
  await fetch(new URL(route, previewUrl)).catch(() => {});
  return {
    root, store, previewUrl, appId,
    async close() {
      server.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
