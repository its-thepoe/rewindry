import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RewindryRuntime } from '../src/runtime.ts';
import type { AgentEvent } from '../src/turn-manager.ts';

async function until(condition: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('observed multi-file turn publishes one final immutable checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-runtime-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'initial');
  const runtime = new RewindryRuntime(root, { manualQuietMs: 100, settleMs: 100, rescanIntervalMs: 100 });
  const makeEvent = (eventType: AgentEvent['eventType'], eventId: string): AgentEvent => ({
    protocolVersion: 1,
    eventId,
    eventType,
    provider: 'cursor',
    adapterVersion: 'fixture',
    occurredAt: new Date().toISOString(),
    workspaceId: runtime.workspaceId,
    hostSessionId: 'session',
    hostTurnId: 'turn',
    status: eventType === 'outer_turn_finished' ? 'completed' : undefined,
    boundaryQuality: 'paired',
  });
  try {
    await runtime.start();
    assert.equal(runtime.store.list().length, 1);
    runtime.ingest(makeEvent('outer_turn_started', 'start'));
    writeFileSync(join(root, 'src', 'app.ts'), 'intermediate');
    await until(() => runtime.observedWrites > 0, 'first write');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(runtime.store.list().length, 1);
    writeFileSync(join(root, 'src', 'app.ts'), 'final');
    writeFileSync(join(root, 'src', 'style.css'), 'body { color: red; }');
    await until(() => runtime.observedWrites > 1, 'final writes');
    runtime.ingest(makeEvent('outer_turn_finished', 'finish'));
    await until(() => runtime.store.list().length === 2, 'checkpoint');
    const [baseline, checkpoint] = runtime.store.list();
    assert.ok(baseline && checkpoint);
    assert.equal(checkpoint.kind, 'agent_turn');
    assert.equal(runtime.store.readFile(checkpoint.id, 'src/app.ts').toString(), 'final');
    assert.equal(runtime.store.readFile(baseline.id, 'src/app.ts').toString(), 'initial');
    runtime.ingest(makeEvent('outer_turn_finished', 'finish'));
    assert.equal(runtime.store.list().length, 2);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged turn adds no dot and two changed turns add exactly two', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-sequence-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'baseline');
  const runtime = new RewindryRuntime(root, { manualQuietMs: 100, settleMs: 50, rescanIntervalMs: 100 });
  let sequence = 0;
  const turn = async (changed: boolean) => {
    const id = ++sequence;
    const makeEvent = (eventType: AgentEvent['eventType']): AgentEvent => ({
      protocolVersion: 1,
      eventId: `${eventType}-${id}`,
      eventType,
      provider: 'cursor',
      adapterVersion: 'fixture',
      occurredAt: new Date().toISOString(),
      workspaceId: runtime.workspaceId,
      hostSessionId: 'session',
      hostTurnId: `turn-${id}`,
      status: eventType === 'outer_turn_finished' ? 'completed' : undefined,
      boundaryQuality: 'paired',
    });
    runtime.ingest(makeEvent('outer_turn_started'));
    if (changed) {
      const before = runtime.observedWrites;
      writeFileSync(join(root, 'src', 'app.ts'), `turn-${id}`);
      await until(() => runtime.observedWrites > before, `turn ${id} write`);
    }
    runtime.ingest(makeEvent('outer_turn_finished'));
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  try {
    await runtime.start();
    await turn(false);
    assert.equal(runtime.store.list().length, 1);
    await turn(true);
    assert.equal(runtime.store.list().length, 2);
    await turn(true);
    assert.equal(runtime.store.list().length, 3);
    assert.deepEqual(runtime.store.list().map((item) => item.kind), ['baseline', 'agent_turn', 'agent_turn']);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart after missing finish preserves changed source as an uncertain group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-restart-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'baseline');
  const first = new RewindryRuntime(root, { manualQuietMs: 80, rescanIntervalMs: 100 });
  try {
    await first.start();
    first.ingest({
      protocolVersion: 1,
      eventId: 'start',
      eventType: 'outer_turn_started',
      provider: 'cursor',
      adapterVersion: 'fixture',
      occurredAt: new Date().toISOString(),
      workspaceId: first.workspaceId,
      hostSessionId: 'session',
      hostTurnId: 'unfinished',
      boundaryQuality: 'paired',
    });
    writeFileSync(join(root, 'src', 'app.ts'), 'changed');
    await until(() => first.observedWrites > 0, 'pre-restart write');
    await first.close();
    const second = new RewindryRuntime(root, { manualQuietMs: 80, rescanIntervalMs: 100 });
    try {
      await second.start();
      await until(() => second.store.list().length === 2, 'recovered group');
      assert.equal(second.store.list()[1]?.kind, 'unattributed_group');
      assert.ok(second.turns.diagnostics.includes('stale_active_turn'));
    } finally {
      await second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only a finalized changed turn queues one screenshot attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-queue-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'baseline');
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ appId: 'fixture', serverId: 'server', generation: 1, readiness: 'unverified' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let captures = 0;
  const runtime = new RewindryRuntime(root, {
    manualQuietMs: 100,
    settleMs: 50,
    rescanIntervalMs: 100,
    preview: {
      url: `http://127.0.0.1:${address.port}/`, appId: 'fixture',
      capturePage: async () => { captures++; return Buffer.from('image'); },
    },
  });
  const makeEvent = (eventType: AgentEvent['eventType'], id: string): AgentEvent => ({
    protocolVersion: 1, eventId: id, eventType, provider: 'cursor', adapterVersion: 'fixture',
    occurredAt: new Date().toISOString(), workspaceId: runtime.workspaceId,
    hostSessionId: 'session', hostTurnId: 'turn', boundaryQuality: 'paired',
    status: eventType === 'outer_turn_finished' ? 'completed' : undefined,
  });
  try {
    await runtime.start();
    runtime.ingest(makeEvent('outer_turn_started', 'start'));
    const before = runtime.observedWrites;
    writeFileSync(join(root, 'src', 'app.ts'), 'changed');
    await until(() => runtime.observedWrites > before, 'queued turn write');
    assert.equal(captures, 0);
    runtime.ingest(makeEvent('outer_turn_finished', 'finish'));
    await until(() => runtime.captureResults.size === 1, 'capture result');
    assert.equal(captures, 1);
    assert.equal([...runtime.captureResults.values()][0]?.status, 'captured');
    runtime.ingest(makeEvent('outer_turn_finished', 'finish'));
    assert.equal(captures, 1);
  } finally {
    await runtime.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
