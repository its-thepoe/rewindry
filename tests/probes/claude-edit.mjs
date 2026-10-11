import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalDaemon } from '../../dist/daemon.js';
import { installHookConfigs, uninstallHookConfigs } from '../../dist/hooks.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'rewindry-claude-edit-')));
const dataDir = mkdtempSync(join(tmpdir(), 'rewindry-claude-daemon-'));
const cli = resolve('dist/cli.js');
const claude = process.env.CLAUDE_BIN || 'claude';
const files = new Map([
  ['src/app.ts', { before: "export const state = 'A';\n", after: "export const state = 'B';\n" }],
  ['src/theme.ts', { before: "export const theme = 'light';\n", after: "export const theme = 'dark';\n" }],
  ['src/count.ts', { before: 'export const count = 1;\n', after: 'export const count = 2;\n' }],
]);
let daemon;
try {
  mkdirSync(join(root, 'src'));
  for (const [path, { before }] of files) writeFileSync(join(root, path), before);
  installHookConfigs(root, cli, realpathSync(process.execPath), dataDir, ['claude-code']);
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();

  const prompt = [
    'Make these three file edits as separate edits, one file at a time:',
    "- src/app.ts must contain exactly: export const state = 'B'; followed by one newline.",
    "- src/theme.ts must contain exactly: export const theme = 'dark'; followed by one newline.",
    '- src/count.ts must contain exactly: export const count = 2; followed by one newline.',
    'After all three edits, run `sleep 30` exactly once before finishing the turn.',
    'Do not edit any other files or run any other commands.',
  ].join('\n');
  const child = spawn(claude, ['--print', '--no-session-persistence', '--output-format', 'json',
    '--max-turns', '10', '--permission-mode', 'acceptEdits', prompt], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 150_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(deadline);
  await new Promise((done) => setTimeout(done, 3_000));

  const checkpoints = daemon.runtime.store.list();
  const turns = checkpoints.filter((checkpoint) => checkpoint.kind === 'agent_turn');
  const current = Object.fromEntries([...files.keys()].map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const historical = turns[0]
    ? Object.fromEntries([...files.keys()].map((path) => [
      path, daemon.runtime.store.readFile(turns[0].id, path).toString('utf8'),
    ]))
    : null;
  const expected = Object.fromEntries([...files].map(([path, { after }]) => [path, after]));
  console.log(JSON.stringify({
    exitCode: code,
    current,
    checkpoints: checkpoints.map(({ kind, turnKey }) => ({ kind, turnKey })),
    historical,
    expected,
    diagnostics: daemon.runtime.turns.diagnostics,
  }, null, 2));
  if (code !== 0 || turns.length !== 1 || JSON.stringify(current) !== JSON.stringify(expected) ||
      JSON.stringify(historical) !== JSON.stringify(expected)) {
    console.error(stderr.split('\n').filter((line) => /error|failed|hook|auth|permission/i.test(line)).slice(0, 20).join('\n'));
    console.error(stdout.slice(-1000));
    process.exitCode = 1;
  }
} finally {
  if (daemon) {
    await daemon.close();
    uninstallHookConfigs(root, dataDir);
  }
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}
