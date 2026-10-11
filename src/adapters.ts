import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent } from './turn-manager.js';

export type Provider = AgentEvent['provider'];
export type ProviderCapability = {
  host: string;
  startHook: string | null;
  finishHooks: readonly string[];
  boundary: 'candidate_paired' | 'end_only' | 'unsupported';
  verifiedVersions: readonly string[];
};

// Published hook schemas show possible boundaries; no host edition has passed the required real E2E probe yet.
export const PROVIDER_CAPABILITIES: Readonly<Record<'cursor-ide' | 'cursor-cli' | 'claude-code' | 'codex-cli', ProviderCapability>> = {
  'cursor-ide': {
    host: 'Cursor IDE', startHook: 'beforeSubmitPrompt', finishHooks: ['stop'],
    boundary: 'candidate_paired', verifiedVersions: [],
  },
  'cursor-cli': {
    host: 'Cursor CLI', startHook: null, finishHooks: [],
    boundary: 'unsupported', verifiedVersions: [],
  },
  'claude-code': {
    host: 'Claude Code', startHook: 'UserPromptSubmit', finishHooks: ['Stop', 'StopFailure'],
    boundary: 'candidate_paired', verifiedVersions: [],
  },
  'codex-cli': {
    host: 'Codex CLI', startHook: 'UserPromptSubmit', finishHooks: ['Stop'],
    boundary: 'candidate_paired', verifiedVersions: ['0.144.4'],
  },
};

type HookPayload = Record<string, unknown>;

function record(value: unknown): HookPayload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as HookPayload : null;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function stableEventId(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function event(
  provider: Provider,
  type: AgentEvent['eventType'],
  workspaceId: string,
  sessionId: string | undefined,
  turnId: string | undefined,
  quality: AgentEvent['boundaryQuality'],
  status?: AgentEvent['status'],
  payloadEventId?: string,
): AgentEvent {
  const eventId = sessionId && turnId
    ? stableEventId([provider, workspaceId, sessionId, turnId, type])
    : payloadEventId
      ? stableEventId([provider, workspaceId, payloadEventId, type])
      : randomUUID();
  return {
    protocolVersion: 1,
    eventId,
    eventType: type,
    provider,
    adapterVersion: '1',
    occurredAt: new Date().toISOString(),
    workspaceId,
    ...(sessionId ? { hostSessionId: sessionId } : {}),
    ...(turnId ? { hostTurnId: turnId } : {}),
    ...(status ? { status } : {}),
    boundaryQuality: quality,
  };
}

function cursorStatus(value: unknown): AgentEvent['status'] {
  if (value === 'completed') return 'completed';
  if (value === 'aborted') return 'aborted';
  if (value === 'error') return 'failed';
  return 'unknown';
}

export function normalizeHook(
  provider: Provider,
  hookName: string,
  payload: unknown,
  workspaceId: string,
): AgentEvent | null {
  const input = record(payload);
  if (!input || !id(workspaceId)) return null;

  if (provider === 'cursor') {
    if (hookName !== 'beforeSubmitPrompt' && hookName !== 'stop') return null;
    if (input.hook_event_name !== hookName || input.agent_id || input.subagent_id ||
      input.parent_conversation_id || input.is_subagent === true) return null;
    const sessionId = id(input.conversation_id);
    const turnId = id(input.generation_id);
    if (hookName === 'beforeSubmitPrompt') {
      return event(provider, 'outer_turn_started', workspaceId, sessionId, turnId,
        sessionId && turnId ? 'paired' : 'unverified', undefined, id(input.event_id));
    }
    return event(provider, 'outer_turn_finished', workspaceId, sessionId, turnId,
      sessionId && turnId ? 'paired' : 'end_only', cursorStatus(input.status), id(input.event_id));
  }

  if (provider === 'claude-code') {
    if (!['UserPromptSubmit', 'Stop', 'StopFailure'].includes(hookName)) return null;
    if (input.hook_event_name !== hookName || input.agent_id) return null;
    const sessionId = id(input.session_id);
    const turnId = id(input.prompt_id);
    if (hookName === 'UserPromptSubmit') {
      return event(provider, 'outer_turn_started', workspaceId, sessionId, turnId,
        sessionId && turnId ? 'paired' : 'unverified', undefined, id(input.event_id));
    }
    // A Stop triggered by an earlier stop-hook continuation is not a proven final boundary.
    const continuing = hookName === 'Stop' && input.stop_hook_active === true;
    const quality = sessionId && turnId && !continuing ? 'paired' : 'end_only';
    return event(provider, 'outer_turn_finished', workspaceId, sessionId, turnId,
      quality, hookName === 'StopFailure' ? 'failed' : continuing ? 'unknown' : 'completed', id(input.event_id));
  }

  if (provider === 'codex-cli') {
    if (hookName === 'agent-turn-complete' && input.type === hookName) {
      const sessionId = id(input['thread-id']);
      const turnId = id(input['turn-id']);
      return event(provider, 'outer_turn_finished', workspaceId, sessionId, turnId,
        'end_only', 'completed', id(input.event_id));
    }
    if (!['UserPromptSubmit', 'Stop'].includes(hookName) || input.hook_event_name !== hookName) return null;
    const sessionId = id(input.session_id);
    const turnId = id(input.turn_id);
    if (hookName === 'UserPromptSubmit') {
      return event(provider, 'outer_turn_started', workspaceId, sessionId, turnId,
        sessionId && turnId ? 'paired' : 'unverified');
    }
    const continuing = input.stop_hook_active === true;
    return event(provider, 'outer_turn_finished', workspaceId, sessionId, turnId,
      sessionId && turnId && !continuing ? 'paired' : 'end_only',
      continuing ? 'unknown' : 'completed');
  }

  return null;
}

export type EventSender = (event: AgentEvent, signal: AbortSignal) => Promise<void>;

// Hook commands can await this and always exit 0, including when the daemon is absent or slow.
export async function forwardHook(
  provider: Provider,
  hookName: string,
  payload: unknown,
  workspaceId: string,
  send: EventSender,
  timeoutMs = 150,
): Promise<boolean> {
  try {
    const normalized = normalizeHook(provider, hookName, payload, workspaceId);
    if (!normalized) return false;
    const controller = new AbortController();
    const boundedTimeout = Math.min(1000, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 150));
    const timeout = setTimeout(() => controller.abort(), boundedTimeout);
    try {
      await Promise.race([
        send(normalized, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Hook forwarding timeout')), { once: true })),
      ]);
      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}
