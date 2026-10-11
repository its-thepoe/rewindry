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
let daemon;
try {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), "export const state = 'A';\n");
  installHookConfigs(root, cli, realpathSync(process.execPath), dataDir, ['claude-code']);
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();

  const prompt = "Edit src/app.ts so it contains exactly: export const state = 'B'; followed by one newline. Do not edit any other file or run commands.";
  const child = spawn(claude, ['--print', '--no-session-persistence', '--output-format', 'json',
    '--max-turns', '5', '--permission-mode', 'acceptEdits', prompt], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(deadline);
  await new Promise((done) => setTimeout(done, 3_000));

  const checkpoints = daemon.runtime.store.list();
  const turns = checkpoints.filter((checkpoint) => checkpoint.kind === 'agent_turn');
  const current = readFileSync(join(root, 'src', 'app.ts'), 'utf8');
  const historical = turns[0]
    ? daemon.runtime.store.readFile(turns[0].id, 'src/app.ts').toString('utf8')
    : null;
  console.log(JSON.stringify({
    exitCode: code,
    current,
    checkpoints: checkpoints.map(({ kind, turnKey }) => ({ kind, turnKey })),
    historical,
    diagnostics: daemon.runtime.turns.diagnostics,
  }, null, 2));
  if (code !== 0 || turns.length !== 1 || current !== "export const state = 'B';\n" || historical !== current) {
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
