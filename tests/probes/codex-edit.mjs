import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalDaemon } from '../../dist/daemon.js';

const root = realpathSync(mkdtempSync(join(resolve('tests/probes'), 'codex-edit-')));
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'rewindry-daemon-')));
const cli = resolve('dist/cli.js');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (name) => [process.execPath, cli, 'hook', 'codex-cli', name,
  '--root', root, '--data-dir', dataDir].map(quote).join(' ');
let daemon;
try {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, 'src', 'app.txt'), 'State A\n');
  const hooks = { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit') }] }],
    Stop: [{ hooks: [{ type: 'command', command: command('Stop') }] }],
  } };
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify(hooks));
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();
  const args = ['exec', '--ephemeral', '--disable', 'plugins', '--disable', 'apps',
    '-m', 'gpt-5.6-sol', '--dangerously-bypass-hook-trust', '-s', 'workspace-write',
    '-C', root, 'Change src/app.txt to contain exactly State B followed by a newline. Do not edit any other file.'];
  const child = spawn(process.env.CODEX_BIN || 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(deadline);
  await new Promise((done) => setTimeout(done, 3_000));
  const checkpoints = daemon.runtime.store.list();
  const turns = checkpoints.filter((checkpoint) => checkpoint.kind === 'agent_turn');
  const result = {
    exitCode: code,
    current: readFileSync(join(root, 'src', 'app.txt'), 'utf8'),
    checkpoints: checkpoints.map(({ kind, turnKey }) => ({ kind, turnKey })),
    historical: turns[0] ? daemon.runtime.store.readFile(turns[0].id, 'src/app.txt').toString('utf8') : null,
    diagnostics: daemon.runtime.turns.diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || turns.length !== 1 || result.current !== 'State B\n' || result.historical !== 'State B\n') {
    console.error(stderr.split('\n').filter((line) => /error:|ERROR|failed|hook:|codex$/i.test(line)).slice(0, 20).join('\n'));
    process.exitCode = 1;
  }
} finally {
  await daemon?.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}
