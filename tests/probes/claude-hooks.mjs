import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'rewindry-claude-probe-'));
const log = join(root, 'hooks.jsonl');
const hookScript = resolve('tests/probes/log-hook.mjs');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `node ${quote(hookScript)} ${quote(log)}`;
const hooks = () => [{ hooks: [{ type: 'command', command }] }];
const claude = process.env.CLAUDE_BIN || 'claude';

try {
  const settings = join(root, '.claude', 'settings.local.json');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ hooks: {
    UserPromptSubmit: hooks('UserPromptSubmit'),
    Stop: hooks('Stop'),
    StopFailure: hooks('StopFailure'),
  } }, null, 2));

  const child = spawn(claude, ['--print', '--no-session-persistence', '--output-format', 'json',
    '--max-turns', '1', 'Reply with READY only. Do not use tools.'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(deadline);
  const events = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const summary = events.map((event) => ({
    hook_event_name: event.hook_event_name,
    session_id: event.session_id,
    prompt_id: event.prompt_id,
    stop_hook_active: event.stop_hook_active,
    keys: Object.keys(event).sort(),
  }));
  console.log(JSON.stringify({ exitCode: code, events: summary }, null, 2));
  if (code !== 0 || !events.some((event) => event.hook_event_name === 'UserPromptSubmit') ||
      !events.some((event) => event.hook_event_name === 'Stop')) {
    console.error(stderr.split('\n').filter((line) => /error|failed|login|auth|trust|hook/i.test(line)).slice(0, 20).join('\n'));
    console.error(stdout.slice(-1000));
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
