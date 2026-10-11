import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TurnManager, type AgentEvent, type Clock } from '../src/turn-manager.ts';

class FakeClock implements Clock {
  now = 0;
  private nextId = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.now + delay, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

function event(type: AgentEvent['eventType'], id: string, turn = 'turn-1', status: AgentEvent['status'] = 'completed'): AgentEvent {
  return {
    protocolVersion: 1,
    eventId: id,
    eventType: type,
    provider: 'cursor',
    adapterVersion: 'test',
    occurredAt: new Date(0).toISOString(),
    workspaceId: 'fixture',
    hostSessionId: 'session-1',
    hostTurnId: turn,
    status: type === 'outer_turn_finished' ? status : undefined,
    boundaryQuality: 'paired',
  };
}

function setup() {
  const clock = new FakeClock();
  const snapshots: Array<{ kind: string; key?: string; metadata?: { overlap: boolean } }> = [];
  const journal = join(mkdtempSync(join(tmpdir(), 'rewindry-turn-')), 'journal.jsonl');
  const manager = new TurnManager('fixture', {
    snapshot(kind, key, metadata) { snapshots.push({ kind, key, ...(metadata ? { metadata } : {}) }); },
  }, journal, clock);
  return { manager, clock, snapshots, journal };
}

test('20 writes with a 60-second pause yield one checkpoint only after completion', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  for (let i = 0; i < 20; i++) {
    manager.onWrite();
    clock.advance(500);
  }
  clock.advance(60_000);
  assert.equal(snapshots.length, 0);
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  clock.advance(1_999);
  assert.equal(snapshots.length, 0);
  clock.advance(1);
  assert.deepEqual(snapshots, [{ kind: 'agent_turn', key: 'cursor:fixture:session-1:turn-1' }]);
});

test('duplicates, repeated finish, and subagent-like unknown finish do not add checkpoints', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  manager.ingest(event('outer_turn_finished', 'finish'));
  manager.ingest(event('outer_turn_finished', 'finish-again'));
  manager.ingest(event('outer_turn_finished', 'subagent-stop', 'subagent'));
  clock.advance(2_000);
  assert.equal(snapshots.length, 1);
  assert.ok(manager.diagnostics.includes('finish_without_start'));
});

test('manual bursts group after quiet time, with separate later burst', () => {
  const { manager, clock, snapshots } = setup();
  manager.onWrite();
  clock.advance(10_000);
  manager.onWrite();
  clock.advance(14_999);
  assert.equal(snapshots.length, 0);
  clock.advance(1);
  assert.equal(snapshots.length, 1);
  manager.onWrite();
  clock.advance(15_000);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((item) => item.kind === 'unattributed_group'));
});

test('failed turn produces no completed checkpoint', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'failed', 'turn-1', 'failed'));
  assert.equal(snapshots.length, 0);
  clock.advance(15_000);
  assert.equal(snapshots[0]?.kind, 'unattributed_group');
  assert.ok(manager.diagnostics.includes('turn_failed'));
});

test('end-only and malformed events never create a confirmed turn', () => {
  const { manager, clock, snapshots } = setup();
  assert.throws(() => manager.ingest({ eventId: 'bad' }), /Invalid event/);
  manager.onWrite();
  manager.ingest({ ...event('outer_turn_finished', 'end-only'), boundaryQuality: 'end_only' });
  clock.advance(15_000);
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group']);
});

test('journal records events and replay deduplicates without republishing', () => {
  const { manager, clock, snapshots, journal } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  clock.advance(2_000);
  const replay = new TurnManager('fixture', {
    snapshot(kind, key) { snapshots.push({ kind, key }); },
  }, journal, clock);
  assert.equal(replay.ingest(event('outer_turn_finished', 'finish')), false);
  assert.equal(readFileSync(journal, 'utf8').trim().split('\n').length, 2);
  assert.equal(snapshots.length, 1);
});

test('journal refuses symlinked files without changing their external targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rewindry-journal-link-'));
  const journal = join(directory, 'journal.jsonl');
  const target = join(directory, 'outside.jsonl');
  writeFileSync(target, 'keep this intact\n');
  symlinkSync(target, journal);

  assert.throws(() => new TurnManager('fixture', { snapshot() {} }, journal), /regular file/);
  assert.equal(readFileSync(target, 'utf8'), 'keep this intact\n');
});

test('journal refuses a symlinked directory before creating a journal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rewindry-journal-dir-link-'));
  const target = join(directory, 'outside');
  const journalDirectory = join(directory, 'journal');
  mkdirSync(target);
  symlinkSync(target, journalDirectory);

  assert.throws(() => new TurnManager('fixture', { snapshot() {} }, join(journalDirectory, 'events.jsonl')), /real directory/);
  assert.equal(existsSync(join(target, 'events.jsonl')), false);
});

test('overlapping turns do not claim a confirmed checkpoint', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'a-start', 'a'));
  manager.ingest(event('outer_turn_started', 'b-start', 'b'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'a-end', 'a'));
  manager.ingest(event('outer_turn_finished', 'b-end', 'b'));
  clock.advance(15_000);
  assert.equal(snapshots.filter((item) => item.kind === 'agent_turn').length, 0);
  assert.deepEqual(snapshots, [{ kind: 'unattributed_group', key: undefined, metadata: { overlap: true } }]);
  assert.ok(manager.diagnostics.includes('overlap'));
});

test('missing finish expires to uncertain grouped edits, never completed turn', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  clock.advance(30 * 60_000 - 1);
  assert.equal(snapshots.length, 0);
  clock.advance(1);
  assert.ok(manager.diagnostics.includes('stale_active_turn'));
  clock.advance(15_000);
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group']);
});

test('a delayed final write lands inside the settled checkpoint', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  clock.advance(1_000);
  manager.onWrite();
  clock.advance(1_999);
  assert.equal(snapshots.length, 0);
  clock.advance(1);
  assert.equal(snapshots.length, 1);
});

test('storage errors are diagnosed and retried without escaping a timer', () => {
  const clock = new FakeClock();
  const journal = join(mkdtempSync(join(tmpdir(), 'rewindry-error-')), 'journal.jsonl');
  let attempts = 0;
  const manager = new TurnManager('fixture', {
    snapshot() {
      attempts++;
      if (attempts < 3) throw new Error('disk unavailable');
    },
  }, journal, clock, 15_000, 2_000);
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  assert.doesNotThrow(() => clock.advance(6_000));
  assert.equal(attempts, 3);
  assert.equal(manager.diagnostics.filter((item) => item.startsWith('snapshot_error:')).length, 2);
});

test('disk-full capture pauses and recovers after the next successful write', () => {
  const clock = new FakeClock();
  const journal = join(mkdtempSync(join(tmpdir(), 'rewindry-full-')), 'journal.jsonl');
  let full = true;
  const manager = new TurnManager('fixture', {
    snapshot() {
      if (full) throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    },
  }, journal, clock);
  manager.onWrite();
  clock.advance(45_000);
  assert.equal(manager.captureFailure, 'storage_full');
  assert.ok(manager.diagnostics.includes('storage_full'));
  full = false;
  manager.onWrite();
  clock.advance(15_000);
  assert.equal(manager.captureFailure, null);
});

test('pending unattributed writes are checkpointed before a new paired turn starts', () => {
  const { manager, clock, snapshots } = setup();
  manager.onWrite();
  clock.advance(1_000);
  manager.ingest(event('outer_turn_started', 'start'));
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group']);
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'finish'));
  clock.advance(2_000);
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group', 'agent_turn']);
});

test('finish arriving before start cannot create a confirmed turn', () => {
  const { manager, clock, snapshots } = setup();
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'early-finish'));
  manager.ingest(event('outer_turn_started', 'late-start'));
  assert.ok(manager.diagnostics.includes('finish_without_start'));
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group']);
  clock.advance(30 * 60_000);
  assert.equal(snapshots.filter((item) => item.kind === 'agent_turn').length, 0);
});

test('a finish delayed beyond the stale lease leaves only uncertain source history', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'start'));
  manager.onWrite();
  clock.advance(30 * 60_000);
  manager.ingest(event('outer_turn_finished', 'delayed-finish'));
  clock.advance(15_000);
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group']);
  assert.ok(manager.diagnostics.includes('stale_active_turn'));
  assert.ok(manager.diagnostics.includes('finish_without_start'));
});

test('a new turn while the previous finish settles does not inherit its confirmed boundary', () => {
  const { manager, clock, snapshots } = setup();
  manager.ingest(event('outer_turn_started', 'first-start', 'first'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'first-finish', 'first'));
  clock.advance(1_000);
  manager.ingest(event('outer_turn_started', 'second-start', 'second'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'second-finish', 'second'));
  clock.advance(2_000);
  assert.deepEqual(snapshots.map((item) => item.kind), ['unattributed_group', 'agent_turn']);
  assert.equal(snapshots[1]?.key, 'cursor:fixture:session-1:second');
  assert.ok(manager.diagnostics.includes('ambiguous_boundary'));
});

test('failed boundary split cannot turn mixed writes into a confirmed checkpoint', () => {
  const clock = new FakeClock();
  const journal = join(mkdtempSync(join(tmpdir(), 'rewindry-ambiguous-')), 'journal.jsonl');
  const snapshots: string[] = [];
  let fail = true;
  const manager = new TurnManager('fixture', {
    snapshot(kind) {
      if (fail) throw new Error('storage unavailable');
      snapshots.push(kind);
    },
  }, journal, clock);
  manager.ingest(event('outer_turn_started', 'first-start', 'first'));
  manager.onWrite();
  manager.ingest(event('outer_turn_finished', 'first-finish', 'first'));
  manager.ingest(event('outer_turn_started', 'second-start', 'second'));
  manager.onWrite();
  fail = false;
  manager.ingest(event('outer_turn_finished', 'second-finish', 'second'));
  clock.advance(15_000);
  assert.deepEqual(snapshots, ['unattributed_group']);
  assert.ok(manager.diagnostics.includes('ambiguous_boundary'));
});
