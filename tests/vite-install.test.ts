import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installViteIntegration, uninstallViteIntegration } from '../src/vite-install.ts';

function fixture(source: string, name = 'vite.config.ts') {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-vite-install-'));
  mkdirSync(join(root, '.rewindry'));
  const config = join(root, name);
  writeFileSync(config, source);
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Vite integration preserves normal config and restores exact original bytes', () => {
  const original = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n// Keep this note.\nexport default defineConfig({ plugins: [react(),] });\n`;
  const { root, config, cleanup } = fixture(original);
  try {
    assert.equal(installViteIntegration(root, '/stable/runtime'), 'installed');
    const installed = readFileSync(config, 'utf8');
    assert.match(installed, /react\(\), rewindryPreviewPlugin\("rewindry-[a-f0-9]{12}"\)/);
    assert.match(installed, /\/stable\/runtime\/dist\/vite-plugin\.js/);
    assert.match(installed, /Keep this note/);
    assert.equal(installViteIntegration(root, '/stable/runtime'), 'already_installed');
    assert.equal(readFileSync(config, 'utf8'), installed);
    assert.equal(uninstallViteIntegration(root), true);
    assert.equal(readFileSync(config, 'utf8'), original);
    assert.equal(uninstallViteIntegration(root), false);
  } finally { cleanup(); }
});

test('Vite integration leaves unsupported or edited configs untouched', () => {
  const unsupported = fixture(`export default defineConfig(({ mode }) => ({ plugins: [] }));\n`);
  try {
    assert.equal(installViteIntegration(unsupported.root, '/stable/runtime'), 'unsupported');
    assert.equal(readFileSync(unsupported.config, 'utf8'), `export default defineConfig(({ mode }) => ({ plugins: [] }));\n`);
  } finally { unsupported.cleanup(); }

  const editable = fixture(`export default { plugins: [] };\n`, 'vite.config.mjs');
  try {
    assert.equal(installViteIntegration(editable.root, '/stable/runtime'), 'installed');
    writeFileSync(editable.config, `${readFileSync(editable.config, 'utf8')}\n// User change.\n`);
    assert.throws(() => uninstallViteIntegration(editable.root), /changed after Rewindry setup/);
    assert.match(readFileSync(editable.config, 'utf8'), /User change/);
  } finally { editable.cleanup(); }
});

test('explicit moved-workspace Vite rebind restores reversible metadata', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-vite-moved-'));
  const root = join(temp, 'project');
  const moved = join(temp, 'moved');
  const original = 'export default { plugins: [] };\n';
  try {
    mkdirSync(join(root, '.rewindry'), { recursive: true });
    writeFileSync(join(root, 'vite.config.ts'), original);
    assert.equal(installViteIntegration(root, '/stable/old'), 'installed');
    renameSync(root, moved);
    assert.throws(() => uninstallViteIntegration(moved), /outside workspace/);
    assert.equal(installViteIntegration(moved, '/stable/new', root), 'installed');
    const rebound = readFileSync(join(moved, 'vite.config.ts'), 'utf8');
    assert.match(rebound, /\/stable\/new\/dist\/vite-plugin\.js/);
    assert.doesNotMatch(rebound, /\/stable\/old/);
    assert.equal(uninstallViteIntegration(moved), true);
    assert.equal(readFileSync(join(moved, 'vite.config.ts'), 'utf8'), original);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('Vite integration rejects symlinked config and metadata without touching targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-vite-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'rewindry-vite-outside-'));
  const target = join(outside, 'config.ts');
  const original = 'export default { plugins: [] };\n';
  try {
    mkdirSync(join(root, '.rewindry'));
    writeFileSync(target, original);
    symlinkSync(target, join(root, 'vite.config.ts'));
    assert.throws(() => installViteIntegration(root, '/stable/runtime'), /not a regular file/);
    assert.equal(readFileSync(target, 'utf8'), original);
    unlinkSync(join(root, 'vite.config.ts'));
    writeFileSync(join(root, 'vite.config.ts'), original);
    assert.equal(installViteIntegration(root, '/stable/runtime'), 'installed');
    const metadata = join(root, '.rewindry', 'vite-integration.json');
    const saved = readFileSync(metadata, 'utf8');
    unlinkSync(metadata);
    writeFileSync(join(outside, 'metadata.json'), saved);
    symlinkSync(join(outside, 'metadata.json'), metadata);
    assert.throws(() => uninstallViteIntegration(root), /not a regular file/);
    assert.equal(readFileSync(join(outside, 'metadata.json'), 'utf8'), saved);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
