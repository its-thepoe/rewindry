import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installHookConfigs, uninstallHookConfigs } from '../src/hooks.ts';
import { LocalDaemon } from '../src/daemon.ts';
import { runCli } from '../src/cli.ts';

test('hook merge preserves existing handlers and exact original bytes on uninstall', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-hooks-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'data');
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const claudePath = join(root, '.claude', 'settings.local.json');
  const cursorOriginal = '{"version":1,"hooks":{"stop":[{"command":"existing-cursor"}]}}\n';
  const claudeOriginal = '{\n  "hooks": {"Stop": [{"hooks": [{"type":"command","command":"existing-claude"}]}]}\n}\n';
  try {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(join(root, '.claude'));
    writeFileSync(cursorPath, cursorOriginal);
    writeFileSync(claudePath, claudeOriginal);
    installHookConfigs(root, '/stable/cli.js', '/stable/node', dataDir);
    const cursor = JSON.parse(readFileSync(cursorPath, 'utf8'));
    const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
    assert.equal(cursor.hooks.stop[0].command, 'existing-cursor');
    assert.equal(cursor.hooks.stop.length, 2);
    assert.equal(claude.hooks.Stop[0].hooks[0].command, 'existing-claude');
    assert.equal(claude.hooks.Stop.length, 2);
    assert.equal(uninstallHookConfigs(root, dataDir), true);
    assert.equal(readFileSync(cursorPath, 'utf8'), cursorOriginal);
    assert.equal(readFileSync(claudePath, 'utf8'), claudeOriginal);
    assert.equal(uninstallHookConfigs(root, dataDir), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('verified Codex hooks preserve existing project handlers and uninstall exactly', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-codex-hooks-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'data');
  const path = join(root, '.codex', 'hooks.json');
  const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing-codex"}]}]}}\n';
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(path, original);
    installHookConfigs(root, '/stable/cli.js', '/stable/node', dataDir, ['codex-cli']);
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(installed.hooks.Stop[0].hooks[0].command, 'existing-codex');
    assert.equal(installed.hooks.Stop.length, 2);
    assert.equal(installed.hooks.UserPromptSubmit.length, 1);
    assert.equal(existsSync(join(root, '.cursor')), false);
    assert.equal(existsSync(join(root, '.claude')), false);
    assert.equal(uninstallHookConfigs(root, dataDir), true);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('explicit moved-workspace hook rebind replaces old-root commands and remains reversible', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-hooks-moved-'));
  const root = join(temp, 'project');
  const moved = join(temp, 'moved');
  const dataDir = join(temp, 'data');
  const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing-codex"}]}]}}\n';
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'hooks.json'), original);
    installHookConfigs(root, '/stable/old-cli.js', '/stable/node', dataDir, ['codex-cli']);
    renameSync(root, moved);
    assert.throws(() => uninstallHookConfigs(moved, dataDir), /does not match/);
    installHookConfigs(moved, '/stable/new-cli.js', '/stable/node', dataDir, ['codex-cli'], root);
    const rebound = readFileSync(join(moved, '.codex', 'hooks.json'), 'utf8');
    assert.match(rebound, /existing-codex/);
    assert.match(rebound, /\/stable\/new-cli\.js/);
    assert.doesNotMatch(rebound, /\/stable\/old-cli\.js/);
    assert.equal(uninstallHookConfigs(moved, dataDir), true);
    assert.equal(readFileSync(join(moved, '.codex', 'hooks.json'), 'utf8'), original);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('uninstall removes only Rewindry entries after user edits', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-hooks-edit-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'data');
  try {
    mkdirSync(root);
    installHookConfigs(root, '/stable/cli.js', '/stable/node', dataDir);
    const cursorPath = join(root, '.cursor', 'hooks.json');
    const claudePath = join(root, '.claude', 'settings.local.json');
    const cursor = JSON.parse(readFileSync(cursorPath, 'utf8'));
    cursor.hooks.stop.push({ command: 'new-cursor-handler' });
    writeFileSync(cursorPath, JSON.stringify(cursor));
    const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
    claude.hooks.Stop.push({ hooks: [{ type: 'command', command: 'new-claude-handler' }] });
    writeFileSync(claudePath, JSON.stringify(claude));
    assert.equal(uninstallHookConfigs(root, dataDir), true);
    const afterCursor = JSON.parse(readFileSync(cursorPath, 'utf8'));
    const afterClaude = JSON.parse(readFileSync(claudePath, 'utf8'));
    assert.deepEqual(afterCursor.hooks.stop, [{ command: 'new-cursor-handler' }]);
    assert.deepEqual(afterClaude.hooks.Stop, [{ hooks: [{ type: 'command', command: 'new-claude-handler' }] }]);
    assert.equal(JSON.stringify(afterCursor).includes('/stable/cli.js'), false);
    assert.equal(JSON.stringify(afterClaude).includes('/stable/cli.js'), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('hook install rolls back the first config when a later config cannot be written', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-hooks-rollback-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'data');
  const outside = join(temp, 'outside');
  const cursorPath = join(root, '.cursor', 'hooks.json');
  const original = '{"version":1,"hooks":{"stop":[{"command":"existing"}]}}\n';
  try {
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(cursorPath, original);
    symlinkSync(outside, join(root, '.claude'));
    assert.throws(() => installHookConfigs(root, '/stable/cli.js', '/stable/node', dataDir), /symlink/);
    assert.equal(readFileSync(cursorPath, 'utf8'), original);
    assert.equal(existsSync(join(dataDir, 'hooks.json')), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('hook CLI forwards a normalized event and always exits successfully when daemon is offline', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-hook-cli-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'data');
  const output: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, error: () => {} };
  try {
    mkdirSync(root);
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn' });
    const args = ['hook', 'codex-cli', 'agent-turn-complete', '--root', root, '--data-dir', dataDir, payload];
    assert.equal(await runCli(args, io), 0);
    assert.equal(await runCli(['hook', 'codex-cli', 'agent-turn-complete', '--root'], io), 0);
    assert.equal(await runCli(['hook', 'codex-cli', 'Stop', '--root', root, '--data-dir', dataDir,
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn', stop_hook_active: false })], io), 0);
    assert.equal(output.at(-1), '{}');
    assert.equal(existsSync(dataDir), false);
    const daemon = new LocalDaemon(root, { dataDir });
    try {
      await daemon.start();
      assert.equal(await runCli(args, io), 0);
      assert.ok(daemon.runtime.turns.diagnostics.includes('unverified_boundary'));
    } finally { await daemon.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
