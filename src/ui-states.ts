import { createHash } from 'node:crypto';
import type { UiStateInput } from './store.ts';

export const MAX_UI_STATES = 200;
const MAX_STEPS = 25;
const MAX_COMPONENTS = 2_000;
const ROUTE = /^\/[^\s#]{0,2047}$/;

export type Locator =
  | { by: 'testid'; value: string; index: number }
  | { by: 'role'; role: string; name: string; index: number }
  | { by: 'css'; value: string; index: number };
export type InteractionStep =
  | { action: 'click'; target: Locator[] }
  | { action: 'select'; target: Locator[]; option: { index: number } }
  | { action: 'key'; key: 'Escape' };
export type LearnedState = UiStateInput & { path: InteractionStep[]; components: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const index = (value: unknown, max = 9_999): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

function locator(value: unknown): Locator {
  if (!isRecord(value) || !index(value.index)) throw new Error('Invalid locator');
  if (value.by === 'testid' && exactKeys(value, ['by', 'value', 'index']) && text(value.value, 200)) {
    return { by: 'testid', value: value.value, index: value.index };
  }
  if (value.by === 'role' && exactKeys(value, ['by', 'role', 'name', 'index']) && text(value.role, 40) && text(value.name, 120)) {
    return { by: 'role', role: value.role, name: value.name, index: value.index };
  }
  if (value.by === 'css' && exactKeys(value, ['by', 'value', 'index']) && text(value.value, 400)) {
    return { by: 'css', value: value.value, index: value.index };
  }
  throw new Error('Invalid locator');
}

function targets(value: unknown): Locator[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('Invalid step target');
  return value.map(locator);
}

function step(value: unknown): InteractionStep {
  if (!isRecord(value)) throw new Error('Invalid step');
  if (value.action === 'click' && exactKeys(value, ['action', 'target'])) return { action: 'click', target: targets(value.target) };
  if (value.action === 'select' && exactKeys(value, ['action', 'target', 'option']) &&
      isRecord(value.option) && exactKeys(value.option, ['index']) && index(value.option.index, 999)) {
    return { action: 'select', target: targets(value.target), option: { index: value.option.index } };
  }
  if (value.action === 'key' && exactKeys(value, ['action', 'key']) && value.key === 'Escape') return { action: 'key', key: 'Escape' };
  throw new Error('Invalid step');
}

export function componentSetHash(components: string[]): string {
  return createHash('sha256').update([...new Set(components)].sort().join('\n')).digest('hex');
}

// Strict allowlist: anything not shaped exactly like a recorder report is refused, so the
// endpoint can never be used to store free-form page data.
export function parseLearnedState(body: unknown): LearnedState {
  if (!isRecord(body) || !exactKeys(body, ['route', 'path', 'components', 'modules'])) throw new Error('Invalid state report');
  if (typeof body.route !== 'string' || !ROUTE.test(body.route)) throw new Error('Invalid state route');
  if (!Array.isArray(body.path) || body.path.length > MAX_STEPS) throw new Error('Invalid state path');
  if (!Array.isArray(body.components) || body.components.length > MAX_COMPONENTS ||
      !body.components.every((key) => text(key, 512) && key.includes('#'))) {
    throw new Error('Invalid state components');
  }
  if (!Array.isArray(body.modules) || !body.modules.every((module) => typeof module === 'string')) throw new Error('Invalid state modules');
  const components = [...new Set(body.components as string[])].sort();
  return {
    origin: 'learned',
    route: body.route,
    path: body.path.map(step),
    components,
    componentSet: componentSetHash(components),
    modules: body.modules as string[],
  };
}
