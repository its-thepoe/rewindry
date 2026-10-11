import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectAgentVersions, runCli, setupPlan, verifiedHookProviders } from '../src/cli.ts';
import { LocalDaemon, queryDaemon, sendHookEvent } from '../src/daemon.ts';
import { RewindryRuntime } from '../src/runtime.ts';
import type { AgentEvent } from '../src/turn-manager.ts';

function fixture(): { root: string; dataDir: string; cleanup: () => void } {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-daemon-'));
  const root = join(temp, 'project');
  const dataDir = join(temp, 'user-data');
  mkdirSync(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'initial');
  return { root, dataDir, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test('Unix socket ingests events and reports active source capture', async () => {
  const { root, dataDir, cleanup } = fixture();
  const runtime = new RewindryRuntime(root, { settleMs: 30, manualQuietMs: 100 });
  const daemon = new LocalDaemon(root, { dataDir, runtime });
  const makeEvent = (eventType: AgentEvent['eventType']): AgentEvent => ({
    protocolVersion: 1, eventId: eventType, eventType, provider: 'cursor', adapterVersion: 'test',
    occurredAt: new Date().toISOString(), workspaceId: runtime.workspaceId,
    hostSessionId: 'session', hostTurnId: 'turn', boundaryQuality: 'paired',
    ...(eventType === 'outer_turn_finished' ? { status: 'completed' } : {}),
  });
  try {
    await daemon.start();
    assert.equal(statSync(daemon.socketPath).mode & 0o777, 0o600);
    const status = await queryDaemon(daemon.socketPath, { action: 'status' });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.status?.checkpointCount, 1);
    assert.equal(status.status?.sourceCapture, 'active');
    runtime.observer.diagnostics.push('watcher_error:injected overflow');
    const degraded = await queryDaemon(daemon.socketPath, { action: 'status' });
    assert.equal(degraded.ok && degraded.status?.sourceCapture, 'degraded');
    assert.equal(degraded.ok && degraded.status?.diagnostics.includes('watcher_error:injected overflow'), true);
    runtime.observer.diagnostics.length = 0;
    runtime.turns.captureFailure = 'storage_full';
    const paused = await queryDaemon(daemon.socketPath, { action: 'status' });
    assert.equal(paused.ok && paused.status?.sourceCapture, 'paused_storage_full');
    runtime.turns.captureFailure = null;
    assert.equal(status.status?.agentBoundaryCapture, 'unverified');
    assert.equal(await sendHookEvent(daemon.socketPath, makeEvent('outer_turn_started')), true);
    assert.equal(await sendHookEvent(daemon.socketPath, makeEvent('outer_turn_started')), false);
    const oversized = await queryDaemon(daemon.socketPath, {
      action: 'event', event: { ...makeEvent('outer_turn_started'), eventId: 'oversized', adapterVersion: 'x'.repeat(70_000) },
    });
    assert.deepEqual(oversized, { ok: false, error: 'Message too large' });
    assert.equal((await queryDaemon(daemon.socketPath, { action: 'status' })).ok, true);
    writeFileSync(join(root, 'src', 'app.ts'), 'changed');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await sendHookEvent(daemon.socketPath, makeEvent('outer_turn_finished')), true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(runtime.store.list().length, 2);
    assert.equal(runtime.store.list()[1]?.kind, 'agent_turn');
    assert.equal(await sendHookEvent(join(dataDir, 'missing.sock'), makeEvent('outer_turn_finished'), 20), false);
  } finally {
    await daemon.close();
    cleanup();
  }
  assert.equal(existsSync(daemon.socketPath), false);
});

test('one daemon isolates status and agent events across registered workspaces', async () => {
  const { root, dataDir, cleanup } = fixture();
  const other = join(dataDir, 'second-project');
  mkdirSync(join(other, 'src'), { recursive: true });
  writeFileSync(join(other, 'src', 'app.ts'), 'second baseline');
  const canonicalRoot = realpathSync(root);
  const canonicalOther = realpathSync(other);
  const otherId = createHash('sha256').update(canonicalOther).digest('hex');
  const daemon = new LocalDaemon(root, { dataDir, workspaceRoots: [root, other] });
  const event = (eventType: AgentEvent['eventType']): AgentEvent => ({
    protocolVersion: 1, eventId: `second-${eventType}`, eventType, provider: 'codex-cli', adapterVersion: 'test',
    occurredAt: new Date().toISOString(), workspaceId: otherId, hostSessionId: 'session', hostTurnId: 'turn',
    boundaryQuality: 'paired', ...(eventType === 'outer_turn_finished' ? { status: 'completed' } : {}),
  });
  try {
    await daemon.start();
    const primary = await queryDaemon(daemon.socketPath, { action: 'status' });
    const secondary = await queryDaemon(daemon.socketPath, { action: 'status', workspaceId: otherId });
    assert.equal(primary.ok && primary.status?.root, canonicalRoot);
    assert.equal(secondary.ok && secondary.status?.root, canonicalOther);
    assert.equal(await sendHookEvent(daemon.socketPath, event('outer_turn_started')), true);
    writeFileSync(join(other, 'src', 'app.ts'), 'second changed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await sendHookEvent(daemon.socketPath, event('outer_turn_finished')), true);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const secondaryAfter = await queryDaemon(daemon.socketPath, { action: 'status', workspaceId: otherId });
    assert.equal(secondaryAfter.ok && secondaryAfter.status?.checkpointCount, 2);
    assert.equal(secondaryAfter.ok && secondaryAfter.status?.root, canonicalOther);
    assert.deepEqual(await queryDaemon(daemon.socketPath, { action: 'status', workspaceId: 'unknown' }), {
      ok: false, error: 'Workspace is not registered with this daemon',
    });
  } finally {
    await daemon.close();
    cleanup();
  }
});

test('a stopping daemon never unlinks a replacement daemon socket', async () => {
  const { root, dataDir, cleanup } = fixture();
  const oldDaemon = new LocalDaemon(root, { dataDir });
  const replacement = new LocalDaemon(root, { dataDir });
  try {
    await oldDaemon.start();
    unlinkSync(oldDaemon.socketPath);
    await replacement.start();
    await oldDaemon.close();
    assert.equal(existsSync(replacement.socketPath), true);
    assert.equal((await queryDaemon(replacement.socketPath, { action: 'status' })).ok, true);
  } finally {
    await replacement.close();
    await oldDaemon.close();
    cleanup();
  }
});

test('status and doctor show truthful capabilities; dry-run setup writes nothing', async () => {
  const { root, dataDir, cleanup } = fixture();
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (line: string) => output.push(line), error: (line: string) => errors.push(line) };
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vite: '^7.0.0' } }));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const plan = setupPlan(root, dataDir);
    assert.equal(plan.framework, 'vite');
    assert.equal(plan.packageManager, 'npm');
    assert.equal(plan.changesApplied, false);
    assert.equal(await runCli(['setup', '--dry-run', '--root', root, '--data-dir', dataDir], io), 0);
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(join(root, '.rewindry')), false);
    assert.equal(await runCli(['setup', '--hooks', '--root', root, '--data-dir', dataDir], io), 1);
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(join(root, '.rewindry')), false);
    assert.ok(errors.some((line) => line.includes('neither edition has passed a real turn-boundary probe')));
    assert.equal(await runCli(['status', '--root', root, '--data-dir', dataDir], io), 1);
    const daemon = new LocalDaemon(root, { dataDir });
    try {
      await daemon.start();
      assert.equal(await runCli(['status', '--root', root, '--data-dir', dataDir], io), 0);
      assert.equal(await runCli(['doctor', '--root', root, '--data-dir', dataDir], io), 0);
      assert.ok(output.some((line) => line.includes('Agent boundary capture: unverified')));
      assert.ok(output.some((line) => line.includes('Visual capture: unavailable')));
    } finally { await daemon.close(); }
  } finally { cleanup(); }
});

test('agent detection is login-free and only verified editions receive automatic hooks', () => {
  const versions = detectAgentVersions((command) => ({
    codex: 'codex-cli 0.144.4',
    cursor: 'Cursor 3.24.9',
    claude: '2.1.296 (Claude Code)',
  }[command] ?? null), () => null);
  assert.deepEqual(versions, {
    'codex-cli': '0.144.4',
    'cursor-ide': '3.24.9',
    'claude-code': '2.1.296',
  });
  assert.deepEqual(verifiedHookProviders(versions), ['codex-cli', 'cursor', 'claude-code']);
  assert.deepEqual(verifiedHookProviders({ 'codex-cli': '0.144.5' }), []);
  assert.equal(detectAgentVersions((command) => command === 'claude' ? '2.1.296 (Claude Code)' : null,
    () => '3.24.9')['cursor-ide'], '3.24.9');
});

test('Cursor IDE detection prefers the installed app version over a CLI probe', () => {
  const commands: string[] = [];
  const versions = detectAgentVersions((command) => {
    commands.push(command);
    return command === 'codex' ? 'codex-cli 0.144.4' : null;
  }, () => '3.24.9');
  assert.equal(versions['cursor-ide'], '3.24.9');
  assert.equal(commands.includes('cursor'), false);
});

test('preview configuration reports pending verification, not a recorded visual', async () => {
  const { root, dataDir, cleanup } = fixture();
  const output: string[] = [];
  const io = { out: (line: string) => output.push(line), error: () => {} };
  try {
    mkdirSync(join(root, '.rewindry'));
    writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({
      preview: { url: 'http://127.0.0.1:5173', appId: 'fixture' },
    }));
    const daemon = new LocalDaemon(root, { dataDir });
    try {
      await daemon.start();
      const response = await queryDaemon(daemon.socketPath, { action: 'status' });
      assert.equal(response.ok && response.status?.visualCapture, 'configured_unverified');
      assert.equal(await runCli(['status', '--root', root, '--data-dir', dataDir], io), 0);
      assert.ok(output.includes('Visual capture: configured, verification pending'));
    } finally { await daemon.close(); }
  } finally { cleanup(); }
});
