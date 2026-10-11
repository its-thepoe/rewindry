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
  ['src/app.ts', { before: "export const state = 'A';\n", first: "export const state = 'B';\n", second: "export const state = 'C';\n" }],
  ['src/theme.ts', { before: "export const theme = 'light';\n", first: "export const theme = 'dark';\n", second: "export const theme = 'blue';\n" }],
  ['src/count.ts', { before: 'export const count = 1;\n', first: 'export const count = 2;\n', second: 'export const count = 3;\n' }],
]);
const turnsToRun = [
  { key: 'first', pause: true },
  { key: 'second', pause: false },
];
let daemon;
try {
  mkdirSync(join(root, 'src'));
  for (const [path, { before }] of files) writeFileSync(join(root, path), before);
  installHookConfigs(root, cli, realpathSync(process.execPath), dataDir, ['claude-code']);
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();

  const run = async ({ key, pause }) => {
    const prompt = [
      `Make these three file edits for the ${key} turn as separate edits, one file at a time:`,
      ...[...files].map(([path, versions]) => `- ${path} must contain exactly: ${versions[key].trim()} followed by one newline.`),
      ...(pause ? ['After all three edits, run `sleep 30` exactly once before finishing the turn.'] : []),
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
    return { code, stdout, stderr };
  };

  const results = [];
  for (const turn of turnsToRun) results.push(await run(turn));

  const checkpoints = daemon.runtime.store.list();
  const turns = checkpoints.filter((checkpoint) => checkpoint.kind === 'agent_turn');
  const readTree = (read) => Object.fromEntries([...files.keys()].map((path) => [path, read(path)]));
  const current = readTree((path) => readFileSync(join(root, path), 'utf8'));
  const expected = turnsToRun.map(({ key }) => Object.fromEntries(
    [...files].map(([path, versions]) => [path, versions[key]]),
  ));
  const historical = turns.map((turn) => readTree(
    (path) => daemon.runtime.store.readFile(turn.id, path).toString('utf8'),
  ));
  console.log(JSON.stringify({
    exitCodes: results.map(({ code }) => code),
    current,
    checkpoints: checkpoints.map(({ kind, turnKey }) => ({ kind, turnKey })),
    historical,
    expected,
    diagnostics: daemon.runtime.turns.diagnostics,
  }, null, 2));
  const lastExpected = expected.at(-1);
  if (results.some(({ code }) => code !== 0) || turns.length !== turnsToRun.length ||
      JSON.stringify(current) !== JSON.stringify(lastExpected) ||
      JSON.stringify(historical) !== JSON.stringify(expected)) {
    for (const { stderr, stdout } of results) {
      console.error(stderr.split('\n').filter((line) => /error|failed|hook|auth|permission/i.test(line)).slice(0, 20).join('\n'));
      console.error(stdout.slice(-1000));
    }
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
