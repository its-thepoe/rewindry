import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = realpathSync(mkdtempSync(join(resolve('tests/probes'), 'codex-probe-')));
const codex = process.env.CODEX_BIN || 'codex';
const log = join(root, 'hooks.jsonl');
const script = resolve('tests/probes/log-hook.mjs');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hook = { hooks: [{ type: 'command', command: `node ${quote(script)} ${quote(log)}` }] };
try {
  if (!existsSync(join(root, '.codex'))) mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [hook], Stop: [hook] } }));
  const args = ['exec', '--ephemeral', '--disable', 'plugins', '--disable', 'apps', '-m', 'gpt-5.6-sol',
    '--dangerously-bypass-hook-trust', '-s', 'read-only', '-C', root, 'Reply OK only. Do not use tools.'];
  const child = spawn(codex, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(deadline);
  const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  console.log(JSON.stringify({ exitCode: code, events: events.map((event) => ({
    hook_event_name: event.hook_event_name,
    session_id: event.session_id,
    turn_id: event.turn_id,
    stop_hook_active: event.stop_hook_active,
    keys: Object.keys(event).sort(),
  })) }, null, 2));
  if (code !== 0 || events.length < 2) {
    console.error(stderr.split('\n').filter((line) => /error:|ERROR|failed|hook:|codex$|model:/i.test(line)).slice(0, 20).join('\n'));
  }
  if (events.length < 2) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
