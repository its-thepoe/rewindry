import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { forwardHook, normalizeHook, PROVIDER_CAPABILITIES } from '../src/adapters.js';

test('Cursor correlates only matching outer generation IDs and preserves failure status', () => {
  const start = normalizeHook('cursor', 'beforeSubmitPrompt', {
    hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conversation-1', generation_id: 'generation-1',
    prompt: 'Never store this prompt',
  }, 'workspace-1');
  const stop = normalizeHook('cursor', 'stop', {
    hook_event_name: 'stop', conversation_id: 'conversation-1', generation_id: 'generation-1', status: 'error',
  }, 'workspace-1');
  assert.ok(start && stop);
  assert.equal(start.boundaryQuality, 'paired');
  assert.equal(stop.boundaryQuality, 'paired');
  assert.equal(stop.status, 'failed');
  assert.equal(start.hostTurnId, stop.hostTurnId);
  assert.notEqual(start.eventId, stop.eventId);
  const duplicate = normalizeHook('cursor', 'stop', {
    hook_event_name: 'stop', conversation_id: 'conversation-1', generation_id: 'generation-1', status: 'error',
  }, 'workspace-1');
  assert.equal(duplicate?.eventId, stop.eventId);
  assert.equal(JSON.stringify(start).includes('Never store this prompt'), false);
});

test('Claude prompt_id pairs a turn; missing ID and continued Stop are not confirmed', () => {
  const base = { session_id: 'session-1', prompt_id: 'prompt-1' };
  const start = normalizeHook('claude-code', 'UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit' }, 'workspace-1');
  const stop = normalizeHook('claude-code', 'Stop', { ...base, hook_event_name: 'Stop' }, 'workspace-1');
  const failure = normalizeHook('claude-code', 'StopFailure', { ...base, hook_event_name: 'StopFailure', error: 'rate_limit' }, 'workspace-1');
  assert.equal(start?.boundaryQuality, 'paired');
  assert.equal(stop?.boundaryQuality, 'paired');
  assert.equal(stop?.status, 'completed');
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.boundaryQuality, 'paired');
  assert.equal(normalizeHook('claude-code', 'Stop', { ...base, hook_event_name: 'Stop', stop_hook_active: true }, 'workspace-1')?.boundaryQuality, 'end_only');
  assert.equal(normalizeHook('claude-code', 'Stop', { session_id: 'session-1', hook_event_name: 'Stop' }, 'workspace-1')?.boundaryQuality, 'end_only');
  assert.equal(normalizeHook('claude-code', 'UserPromptSubmit', { session_id: 'session-1', hook_event_name: 'UserPromptSubmit' }, 'workspace-1')?.boundaryQuality, 'unverified');
});

test('Codex real 0.144.4 hook fixture pairs one outer turn; legacy notifications remain end-only', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-cli-0.144.4.json', import.meta.url), 'utf8')) as {
    events: Record<string, unknown>[];
  };
  const start = normalizeHook('codex-cli', 'UserPromptSubmit', fixture.events[0], 'workspace-1');
  const stop = normalizeHook('codex-cli', 'Stop', fixture.events[1], 'workspace-1');
  assert.equal(start?.boundaryQuality, 'paired');
  assert.equal(stop?.boundaryQuality, 'paired');
  assert.equal(stop?.status, 'completed');
  assert.equal(start?.hostTurnId, stop?.hostTurnId);
  assert.equal(start?.hostSessionId, stop?.hostSessionId);
  assert.notEqual(start?.eventId, stop?.eventId);
  assert.equal(normalizeHook('codex-cli', 'Stop', { ...fixture.events[1], stop_hook_active: true }, 'workspace-1')?.boundaryQuality, 'end_only');
  const payload = { type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1', cwd: '/project' };
  const first = normalizeHook('codex-cli', 'agent-turn-complete', payload, 'workspace-1');
  const duplicate = normalizeHook('codex-cli', 'agent-turn-complete', payload, 'workspace-1');
  assert.equal(first?.boundaryQuality, 'end_only');
  assert.equal(first?.status, 'completed');
  assert.equal(first?.eventId, duplicate?.eventId);
  assert.equal(PROVIDER_CAPABILITIES['codex-cli'].startHook, 'UserPromptSubmit');
  assert.deepEqual(PROVIDER_CAPABILITIES['codex-cli'].verifiedVersions, ['0.144.4']);
});

test('subagent hooks and malformed payloads are ignored', () => {
  assert.equal(normalizeHook('claude-code', 'SubagentStop', { session_id: 's', prompt_id: 'p', hook_event_name: 'SubagentStop' }, 'w'), null);
  assert.equal(normalizeHook('claude-code', 'Stop', { session_id: 's', prompt_id: 'p', agent_id: 'child', hook_event_name: 'Stop' }, 'w'), null);
  assert.equal(normalizeHook('cursor', 'stop', { conversation_id: 'c', generation_id: 'g', is_subagent: true, hook_event_name: 'stop' }, 'w'), null);
  assert.equal(normalizeHook('cursor', 'stop', { conversation_id: 'c', generation_id: 'g', hook_event_name: 'beforeSubmitPrompt' }, 'w'), null);
  assert.equal(normalizeHook('codex-cli', 'agent-turn-complete', { type: 'other' }, 'w'), null);
  assert.equal(normalizeHook('claude-code', 'Stop', [], 'w'), null);
  assert.equal(normalizeHook('claude-code', 'Stop', {}, ''), null);
});

test('forwarder fails open on unavailable and slow senders', async () => {
  const payload = { type: 'agent-turn-complete', 'thread-id': 'thread-1', 'turn-id': 'turn-1' };
  assert.equal(await forwardHook('codex-cli', 'agent-turn-complete', payload, 'w', async () => {
    throw new Error('daemon unavailable');
  }), false);
  const startedAt = Date.now();
  assert.equal(await forwardHook('codex-cli', 'agent-turn-complete', payload, 'w', async (_event, signal) => {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, 20), false);
  assert.ok(Date.now() - startedAt < 150);
  assert.equal(await forwardHook('codex-cli', 'agent-turn-complete', payload, 'w', async () => {}), true);
});
