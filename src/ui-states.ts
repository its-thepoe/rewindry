import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { UiStateInput } from './store.ts';

export const MAX_UI_STATES = 200;
const MAX_STEPS = 25;
const MAX_COMPONENTS = 2_000;
// A leading `//` (or a backslash, which URL parsing treats as `/`) would resolve to another host.
const ROUTE = /^\/(?!\/)[^\s#\\]{0,2047}$/;

export type Locator =
  | { by: 'testid'; value: string; index: number }
  | { by: 'role'; role: string; name: string; index: number }
  | { by: 'css'; value: string; index: number };
export type InteractionStep =
  | { action: 'click'; target: Locator[] }
  | { action: 'select'; target: Locator[]; option: { index: number } }
  | { action: 'key'; key: 'Escape' };
// A screen reached by a click that changed the URL keeps the earlier page's steps (a dismissed
// welcome sheet, say), so its path starts by loading the URL where those steps began.
export type StartStep = { action: 'load'; route: string };
export type LearnedStep = StartStep | InteractionStep;
export type LearnedState = UiStateInput & { path: LearnedStep[]; components: string[] };

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

function step(value: unknown, position: number): LearnedStep {
  if (!isRecord(value)) throw new Error('Invalid step');
  if (value.action === 'load' && position === 0 && exactKeys(value, ['action', 'route']) &&
      typeof value.route === 'string' && ROUTE.test(value.route)) {
    return { action: 'load', route: value.route };
  }
  if (value.action === 'click' && exactKeys(value, ['action', 'target'])) return { action: 'click', target: targets(value.target) };
  if (value.action === 'select' && exactKeys(value, ['action', 'target', 'option']) &&
      isRecord(value.option) && exactKeys(value.option, ['index']) && index(value.option.index, 999)) {
    return { action: 'select', target: targets(value.target), option: { index: value.option.index } };
  }
  if (value.action === 'key' && exactKeys(value, ['action', 'key']) && value.key === 'Escape') return { action: 'key', key: 'Escape' };
  throw new Error('Invalid step');
}

// Where replay starts and which steps it performs there.
export function replayStart(route: string, path: unknown[]): { route: string; steps: InteractionStep[] } {
  const first = path[0] as Partial<StartStep> | undefined;
  return first?.action === 'load' && typeof first.route === 'string'
    ? { route: first.route, steps: path.slice(1) as InteractionStep[] }
    : { route, steps: path as InteractionStep[] };
}

export function componentSetHash(components: string[]): string {
  return createHash('sha256').update([...new Set(components)].sort().join('\n')).digest('hex');
}

// React 18 attributes components to absolute file paths. Keys are stored project-relative, like
// React 19's URL paths; a file outside the project root cannot be attributed and yields null.
export function projectRelativeKey(key: string, root: string): string | null {
  const split = key.lastIndexOf('#');
  const file = key.slice(0, split);
  if (!/^(?:\/|[A-Za-z]:\/)/.test(file)) return key;
  const path = relative(root, file);
  if (!path || path.startsWith('..') || isAbsolute(path)) return null;
  return `${path.split(sep).join('/')}${key.slice(split)}`;
}

// A page as loaded is one screen whatever it contains, so its history survives adding components.
export const LANDING_SET = componentSetHash(['@landing']);

// Strict allowlist: anything not shaped exactly like a recorder report is refused, so the
// endpoint can never be used to store free-form page data.
export function parseLearnedState(body: unknown, root?: string): LearnedState {
  if (!isRecord(body) || !exactKeys(body, ['route', 'path', 'components', 'modules'])) throw new Error('Invalid state report');
  if (typeof body.route !== 'string' || !ROUTE.test(body.route)) throw new Error('Invalid state route');
  if (!Array.isArray(body.path) || body.path.length > MAX_STEPS) throw new Error('Invalid state path');
  if (!Array.isArray(body.components) || body.components.length > MAX_COMPONENTS ||
      !body.components.every((key) => text(key, 512) && key.includes('#'))) {
    throw new Error('Invalid state components');
  }
  if (!Array.isArray(body.modules) || !body.modules.every((module) => typeof module === 'string')) throw new Error('Invalid state modules');
  const keys = body.components as string[];
  const components = [...new Set(root ? keys.map((key) => projectRelativeKey(key, root)).filter((key): key is string => !!key) : keys)].sort();
  return {
    origin: 'learned',
    route: body.route,
    path: body.path.map((value, position) => step(value, position)),
    components,
    componentSet: body.path.length ? componentSetHash(components) : LANDING_SET,
    modules: body.modules as string[],
  };
}
