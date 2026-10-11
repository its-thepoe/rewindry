import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type AgentEvent = {
  protocolVersion: 1;
  eventId: string;
  eventType: 'outer_turn_started' | 'outer_turn_finished';
  provider: 'cursor' | 'claude-code' | 'codex-cli' | 'unknown';
  adapterVersion: string;
  occurredAt: string;
  workspaceId: string;
  hostSessionId?: string;
  hostTurnId?: string;
  status?: 'completed' | 'failed' | 'aborted' | 'unknown';
  boundaryQuality: 'paired' | 'end_only' | 'unverified';
};

export type Clock = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type CheckpointWriter = {
  snapshot(kind: 'agent_turn' | 'unattributed_group', turnKey?: string, metadata?: { overlap: boolean }): unknown;
};

type ActiveTurn = { key: string; workspaceId: string; overlap: boolean; ambiguous: boolean };

const systemClock: Clock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class TurnManager {
  private readonly eventIds = new Set<string>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly finished = new Set<string>();
  private readonly staleTimers = new Map<string, unknown>();
  private manualTimer: unknown;
  private settleTimer: unknown;
  private settlingKey?: string;
  private manualAttempts = 0;
  private settleAttempts = 0;
  private dirty = false;
  private dirtyOverlap = false;
  captureFailure: 'storage_full' | 'source_budget_exceeded' | 'snapshot_error' | null = null;
  readonly diagnostics: string[] = [];

  constructor(
    private readonly workspaceId: string,
    private readonly writer: CheckpointWriter,
    private readonly journalPath: string,
    private readonly clock: Clock = systemClock,
    private readonly manualQuietMs = 15_000,
    private readonly settleMs = 2_000,
    private readonly staleTurnMs = 30 * 60_000,
  ) {
    const existingJournal = this.openJournal(constants.O_RDONLY, false);
    if (existingJournal !== undefined) {
      let contents: string;
      try {
        contents = readFileSync(existingJournal, 'utf8');
      } finally {
        closeSync(existingJournal);
      }
      for (const line of contents.split('\n')) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as AgentEvent;
          this.eventIds.add(event.eventId);
          const key = turnKey(event);
          if (event.eventType === 'outer_turn_started' && key) {
            this.active.set(key, { key, workspaceId: event.workspaceId, overlap: false, ambiguous: false });
          } else if (event.eventType === 'outer_turn_finished' && key) {
            this.active.delete(key);
            this.finished.add(key);
          }
        } catch {
          this.diagnostics.push('malformed_journal_entry');
        }
      }
      if (this.active.size) {
        this.active.clear();
        this.diagnostics.push('stale_active_turn');
      }
    }
  }

  onWrite(): void {
    this.dirty = true;
    if (this.active.size) return;
    if (this.settleTimer !== undefined && this.settlingKey) {
      this.scheduleSettle(this.settlingKey);
      return;
    }
    this.scheduleManual();
  }

  close(): void {
    if (this.manualTimer !== undefined) this.clock.clearTimeout(this.manualTimer);
    if (this.settleTimer !== undefined) this.clock.clearTimeout(this.settleTimer);
    for (const timer of this.staleTimers.values()) this.clock.clearTimeout(timer);
    this.staleTimers.clear();
  }

  ingest(value: unknown): boolean {
    const event = parseEvent(value);
    if (event.workspaceId !== this.workspaceId) throw new Error('Wrong workspace');
    if (this.eventIds.has(event.eventId)) return false;
    const journal = this.openJournal(constants.O_WRONLY | constants.O_APPEND, true);
    if (journal === undefined) throw new Error('Unable to open event journal');
    try {
      writeSync(journal, `${JSON.stringify(event)}\n`);
    } finally {
      closeSync(journal);
    }
    this.eventIds.add(event.eventId);

    const key = turnKey(event);
    if (event.boundaryQuality !== 'paired' || !key) {
      this.diagnostics.push('unverified_boundary');
      return true;
    }

    if (event.eventType === 'outer_turn_started') {
      if (this.finished.has(key) || this.active.has(key)) return true;
      this.settleAttempts = 0;
      this.manualAttempts = 0;
      let ambiguous = false;
      if (this.manualTimer !== undefined) {
        this.clock.clearTimeout(this.manualTimer);
        this.manualTimer = undefined;
        if (this.dirty) {
          if (this.trySnapshot('unattributed_group')) this.dirty = false;
          else ambiguous = true;
        }
      }
      if (this.settleTimer !== undefined) {
        this.clock.clearTimeout(this.settleTimer);
        this.settleTimer = undefined;
        this.settlingKey = undefined;
        this.diagnostics.push('ambiguous_boundary');
        if (this.dirty) {
          if (this.trySnapshot('unattributed_group')) this.dirty = false;
          else ambiguous = true;
        }
      }
      if (ambiguous) this.diagnostics.push('ambiguous_boundary');
      const overlap = this.active.size > 0;
      if (overlap) {
        for (const turn of this.active.values()) turn.overlap = true;
        this.dirtyOverlap = true;
        this.diagnostics.push('overlap');
      }
      this.active.set(key, { key, workspaceId: event.workspaceId, overlap, ambiguous });
      this.staleTimers.set(key, this.clock.setTimeout(() => {
        this.staleTimers.delete(key);
        if (!this.active.delete(key)) return;
        this.diagnostics.push('stale_active_turn');
        if (this.active.size === 0 && this.dirty) this.scheduleManual();
      }, this.staleTurnMs));
      return true;
    }

    if (this.finished.has(key)) return true;
    const active = this.active.get(key);
    if (!active) {
      this.diagnostics.push('finish_without_start');
      return true;
    }
    this.active.delete(key);
    const staleTimer = this.staleTimers.get(key);
    if (staleTimer !== undefined) this.clock.clearTimeout(staleTimer);
    this.staleTimers.delete(key);
    this.finished.add(key);
    if (event.status !== 'completed') {
      this.diagnostics.push(`turn_${event.status}`);
      if (this.active.size === 0 && this.dirty) this.scheduleManual();
      return true;
    }
    if (active.overlap || active.ambiguous || this.active.size) {
      this.diagnostics.push('ambiguous_boundary');
      if (this.active.size === 0 && this.dirty) this.scheduleManual();
      return true;
    }
    this.scheduleSettle(key);
    return true;
  }

  private scheduleManual(): void {
    if (this.manualTimer !== undefined) this.clock.clearTimeout(this.manualTimer);
    this.manualTimer = this.clock.setTimeout(() => {
      this.manualTimer = undefined;
      if (this.active.size || !this.dirty) return;
      if (this.trySnapshot('unattributed_group')) {
        this.dirty = false;
        this.manualAttempts = 0;
      } else if (++this.manualAttempts < 3) {
        this.scheduleManual();
      }
    }, this.manualQuietMs);
  }

  private openJournal(flags: number, create: boolean): number | undefined {
    const directory = dirname(this.journalPath);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      if (!lstatSync(directory).isDirectory()) throw new Error('Event journal directory must be a real directory');
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const file = lstatSync(this.journalPath);
      if (!file.isFile()) throw new Error('Event journal must be a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return undefined;
        throw error;
      }
    }
    const fd = openSync(this.journalPath, flags | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new Error('Event journal must be a regular file');
    }
    return fd;
  }

  private scheduleSettle(key: string): void {
    if (this.settleTimer !== undefined) this.clock.clearTimeout(this.settleTimer);
    this.settlingKey = key;
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = undefined;
      this.settlingKey = undefined;
      if (this.active.size) {
        this.diagnostics.push('ambiguous_boundary');
        return;
      }
      if (this.trySnapshot('agent_turn', key)) {
        this.dirty = false;
        this.settleAttempts = 0;
      } else if (++this.settleAttempts < 3) {
        this.scheduleSettle(key);
      }
    }, this.settleMs);
  }

  private trySnapshot(kind: 'agent_turn' | 'unattributed_group', key?: string): boolean {
    try {
      this.writer.snapshot(kind, key, kind === 'unattributed_group' && this.dirtyOverlap ? { overlap: true } : undefined);
      this.dirtyOverlap = false;
      this.captureFailure = null;
      return true;
    } catch (error) {
      this.captureFailure = 'snapshot_error';
      if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
        this.captureFailure = 'storage_full';
        this.diagnostics.push('storage_full');
      }
      if (error instanceof Error && error.message.startsWith('Source storage budget exceeded')) {
        this.captureFailure = 'source_budget_exceeded';
        this.diagnostics.push('source_budget_exceeded');
      }
      this.diagnostics.push(`snapshot_error:${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

function turnKey(event: AgentEvent): string | null {
  if (!event.hostSessionId || !event.hostTurnId) return null;
  return `${event.provider}:${event.workspaceId}:${event.hostSessionId}:${event.hostTurnId}`;
}

export function parseEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid event');
  const event = value as Record<string, unknown>;
  if (
    event.protocolVersion !== 1 ||
    typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 256 ||
    !['outer_turn_started', 'outer_turn_finished'].includes(String(event.eventType)) ||
    !['cursor', 'claude-code', 'codex-cli', 'unknown'].includes(String(event.provider)) ||
    typeof event.adapterVersion !== 'string' ||
    typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) ||
    typeof event.workspaceId !== 'string' || !event.workspaceId ||
    !['paired', 'end_only', 'unverified'].includes(String(event.boundaryQuality)) ||
    (event.hostSessionId !== undefined && typeof event.hostSessionId !== 'string') ||
    (event.hostTurnId !== undefined && typeof event.hostTurnId !== 'string') ||
    (event.eventType === 'outer_turn_finished' && !['completed', 'failed', 'aborted', 'unknown'].includes(String(event.status)))
  ) throw new Error('Invalid event');
  return event as AgentEvent;
}
