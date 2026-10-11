import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../../dist/cli.js';
import { daemonSocketPath, queryDaemon } from '../../dist/daemon.js';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rewindry-setup-')));
const root = join(temp, 'project');
const dataDir = join(temp, 'data');
const originalConfig = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`;
const plist = join(homedir(), 'Library', 'LaunchAgents', 'dev.rewindry.daemon.plist');
const output = [];
const errors = [];
const io = { out: (line) => output.push(line), error: (line) => errors.push(line) };
let installed = false;
try {
  assert.equal(existsSync(plist), false, 'service label must be free for the disposable probe');
  mkdirSync(join(root, 'src'), { recursive: true });
  const example = resolve('examples/vite-react');
  for (const name of ['index.html', 'package.json']) cpSync(join(example, name), join(root, name));
  cpSync(join(example, 'src', 'main.tsx'), join(root, 'src', 'main.tsx'));
  symlinkSync(join(example, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'vite.config.ts'), originalConfig);
  assert.equal(await runCli(['setup', '--root', root, '--data-dir', dataDir], io), 0, errors.join('\n'));
  installed = true;
  const status = await queryDaemon(daemonSocketPath(dataDir), { action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.status?.checkpointCount, 1);
  assert.match(readFileSync(join(root, 'vite.config.ts'), 'utf8'), /rewindryPreviewPlugin/);
  assert.match(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'), /UserPromptSubmit/);
  assert.match(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'), /"Stop"/);
  assert.equal(await runCli(['uninstall', '--root', root, '--data-dir', dataDir], io), 0, errors.join('\n'));
  installed = false;
  assert.equal(readFileSync(join(root, 'vite.config.ts'), 'utf8'), originalConfig);
  assert.equal(existsSync(join(root, '.codex', 'hooks.json')), false);
  assert.equal(existsSync(join(root, '.rewindry', 'index.sqlite')), true);
  assert.equal(existsSync(plist), false);
  console.log(JSON.stringify({ setup: 'passed', daemon: 'active', vite: 'integrated', codexHooks: 'installed', uninstall: 'restored', history: 'preserved' }, null, 2));
} finally {
  if (installed) {
    const code = await runCli(['uninstall', '--root', root, '--data-dir', dataDir], io);
    if (code !== 0) console.error(`Cleanup needs attention: ${temp}\n${errors.join('\n')}`);
  }
  if (!existsSync(plist)) rmSync(temp, { recursive: true, force: true });
}
