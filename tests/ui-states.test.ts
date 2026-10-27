import assert from 'node:assert/strict';
import test from 'node:test';
import { LANDING_SET, componentSetHash, parseLearnedState } from '../src/ui-states.ts';

const click = { action: 'click', target: [{ by: 'role', role: 'button', name: 'Item 2', index: 0 }, { by: 'css', value: 'main > section > button:nth-of-type(2)', index: 0 }] };
const report = (overrides: Record<string, unknown> = {}) => ({
  route: '/?screen=home', path: [click, { action: 'key', key: 'Escape' }],
  components: ['src/Cell.tsx#Cell', 'src/App.tsx#App', 'src/Cell.tsx#Cell'], modules: ['src/App.tsx'], ...overrides,
});

test('a recorder report becomes a learned state keyed by its visible component set', () => {
  const state = parseLearnedState(report());
  assert.equal(state.origin, 'learned');
  assert.deepEqual(state.components, ['src/App.tsx#App', 'src/Cell.tsx#Cell']);
  assert.equal(state.componentSet, componentSetHash(['src/Cell.tsx#Cell', 'src/App.tsx#App']));
  assert.equal(state.path.length, 2);
  const select = { action: 'select', target: [{ by: 'testid', value: 'size', index: 0 }], option: { index: 2 } };
  assert.deepEqual(parseLearnedState(report({ path: [select] })).path, [select]);
  assert.equal(parseLearnedState(report({ components: [] })).componentSet, componentSetHash([]));
  // A page as loaded keeps one identity per URL however its components change.
  const landing = parseLearnedState(report({ path: [] }));
  assert.equal(landing.componentSet, LANDING_SET);
  assert.equal(parseLearnedState(report({ path: [], components: ['src/New.tsx#New'] })).componentSet, LANDING_SET);
  assert.deepEqual(landing.components, ['src/App.tsx#App', 'src/Cell.tsx#Cell']);
});

test('reports carrying typed text, values or unknown fields are refused', () => {
  const refused: [Record<string, unknown>, RegExp][] = [
    [report({ path: [{ action: 'type', target: click.target, text: 'my password' }] }), /Invalid step/],
    [report({ path: [{ ...click, value: 'hunter2' }] }), /Invalid step/],
    [report({ path: [{ action: 'click', target: [{ by: 'role', role: 'textbox', name: 'Email', index: 0, value: 'me@example.com' }] }] }), /Invalid locator/],
    [report({ path: [{ action: 'key', key: 'a' }] }), /Invalid step/],
    [report({ path: [{ action: 'click', target: [] }] }), /Invalid step target/],
    [report({ path: [{ action: 'click', target: [{ by: 'xpath', value: '//a', index: 0 }] }] }), /Invalid locator/],
    [report({ path: Array.from({ length: 26 }, () => click) }), /Invalid state path/],
    [report({ route: 'https://evil.example/' }), /Invalid state route/],
    [report({ route: '/#fragment' }), /Invalid state route/],
    [report({ components: ['no-hash-separator'] }), /Invalid state components/],
    [report({ cookies: 'session=1' }), /Invalid state report/],
    [report({ storage: {} }), /Invalid state report/],
  ];
  for (const [body, error] of refused) assert.throws(() => parseLearnedState(body), error, JSON.stringify(body));
  assert.throws(() => parseLearnedState(null), /Invalid state report/);
});
