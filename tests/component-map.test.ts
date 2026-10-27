import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { componentMapScript, type ComponentMap, type ComponentMapOptions } from '../src/component-map.ts';

const ORIGIN = 'http://127.0.0.1:5173';
type Fiber = { tag: number; type?: unknown; child?: Fiber; sibling?: Fiber; stateNode?: unknown; _debugOwner?: Fiber; _debugStack?: { stack: string }; alternate?: Fiber };

const collect = (options: ComponentMapOptions): ComponentMap =>
  JSON.parse(JSON.stringify(runInNewContext(`(${componentMapScript()})`, { URL })(options))) as ComponentMap;
const stack = (file: string) => ({ stack: [
  'Error: react-stack-top-frame',
  `    at exports.jsxDEV (${ORIGIN}/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)`,
  `    at Owner (${ORIGIN}/${file}?t=17:4:12)`,
].join('\n') });
const host = (left: number, top: number, width: number, height: number) => ({
  getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
});
const component = (name: string): Fiber => ({ tag: 0, type: Object.assign(() => null, { displayName: name }) });
const link = (parent: Fiber, ...children: Fiber[]) => {
  parent.child = children[0];
  children.forEach((child, index) => { child.sibling = children[index + 1]; });
  return parent;
};

test('attributes components to their own source file through owned fibers', () => {
  const app = component('App');
  const header = component('Header');
  const badge = component('Badge');
  const board = component('Board');
  const cells = [component('Cell'), component('Cell')];
  const dialog = component('ItemDialog');
  const badgeSpan: Fiber = { tag: 5, stateNode: host(0, 0, 100, 20), _debugOwner: badge, _debugStack: stack('src/Badge.tsx') };
  Object.assign(header, { _debugOwner: app, _debugStack: stack('src/main.tsx') });
  Object.assign(badge, { _debugOwner: header, _debugStack: stack('src/Header.tsx') });
  Object.assign(board, { _debugOwner: app, _debugStack: stack('src/main.tsx') });
  Object.assign(dialog, { _debugOwner: app, _debugStack: stack('src/main.tsx') });
  const cellButtons = cells.map((cell, index) => {
    Object.assign(cell, { _debugOwner: board, _debugStack: stack('src/Board.tsx') });
    return link(cell, { tag: 5, stateNode: host(index * 90, 50, 80, 80), _debugOwner: cell, _debugStack: stack('src/Cell.tsx') });
  });
  const section: Fiber = link({ tag: 5, stateNode: host(0, 50, 260, 80), _debugOwner: board, _debugStack: stack('src/Board.tsx') }, ...cellButtons);
  link(board, section);
  const portal = link({ tag: 4 }, { tag: 5, stateNode: host(40, 300, 240, 100), _debugOwner: dialog, _debugStack: stack('src/ItemDialog.tsx') });
  link(dialog, portal);
  link(header, link(badge, badgeSpan));
  const main: Fiber = link({ tag: 5, stateNode: host(0, 0, 400, 140), _debugOwner: app, _debugStack: stack('src/main.tsx') }, header, board, dialog);
  link(app, main);
  const root = link({ tag: 3 }, app);

  const map = collect({ roots: [root], origin: ORIGIN, scrollX: 0, scrollY: 10 });
  assert.equal(map.unattributed, 0);
  assert.deepEqual(map.components.map((item) => `${item.key}:${item.occurrence}`), [
    'src/main.tsx#App:0', 'src/Header.tsx#Header:0', 'src/Badge.tsx#Badge:0', 'src/Board.tsx#Board:0',
    'src/Cell.tsx#Cell:0', 'src/Cell.tsx#Cell:1', 'src/ItemDialog.tsx#ItemDialog:0',
  ]);
  const byKey = (key: string, occurrence = 0) => map.components.find((item) => item.key === key && item.occurrence === occurrence)!.box;
  assert.deepEqual(byKey('src/Cell.tsx#Cell', 1), { x: 90, y: 60, width: 80, height: 80 });
  assert.deepEqual(byKey('src/ItemDialog.tsx#ItemDialog'), { x: 40, y: 310, width: 240, height: 100 });
  // App's box includes the portal content rendered outside its DOM subtree.
  assert.deepEqual(byKey('src/main.tsx#App'), { x: 0, y: 10, width: 400, height: 400 });
});

test('skips JSX wrapper frames and credits library components to their own file', () => {
  const wrapped = component('Themed');
  link(wrapped, { tag: 5, stateNode: host(0, 0, 10, 10), _debugOwner: wrapped, _debugStack: { stack: [
    'Error: react-stack-top-frame',
    `    at exports.jsxDEV (${ORIGIN}/.vite-cache/deps/react_jsx-dev-runtime.js?v=1:250:30)`,
    `    at jsxDEV (${ORIGIN}/node_modules/.vite/deps/@emotion_react.js?v=1:90:12)`,
    `    at Themed (${ORIGIN}/src/Themed.tsx:3:10)`,
  ].join('\n') } });
  const library = component('Tooltip');
  link(library, { tag: 5, stateNode: host(0, 0, 10, 10), _debugOwner: library, _debugStack: stack('node_modules/.vite/deps/ui-kit.js') });
  const map = collect({ roots: [link({ tag: 3 }, wrapped, library)], origin: ORIGIN, scrollX: 0, scrollY: 0 });
  assert.deepEqual(map.components.map((item) => item.key), ['src/Themed.tsx#Themed', 'node_modules/.vite/deps/ui-kit.js#Tooltip']);
});

test('React 18 fibers fall back to _debugSource and keep the absolute path for the caller to relativize', () => {
  const cell = component('Cell');
  const board = component('Board');
  Object.assign(cell, { _debugOwner: board, _debugSource: { fileName: '/work/app/src/Board.tsx', lineNumber: 4 } });
  link(cell, { tag: 5, stateNode: host(0, 0, 10, 10), _debugOwner: cell, _debugSource: { fileName: '/work/app/src/Cell.tsx', lineNumber: 2 } } as Fiber);
  const library = component('Portal');
  link(library, { tag: 5, stateNode: host(0, 0, 10, 10), _debugOwner: library, _debugSource: { fileName: '/work/app/node_modules/ui/Portal.js' } } as Fiber);
  link(board, { tag: 5, stateNode: host(0, 0, 40, 10), _debugOwner: board, _debugSource: { fileName: '/work/app/src/Board.tsx' } } as Fiber, cell);
  const map = collect({ roots: [link({ tag: 3 }, board, library)], origin: ORIGIN, scrollX: 0, scrollY: 0 });
  assert.deepEqual(map.components.map((item) => item.key), ['/work/app/src/Board.tsx#Board', '/work/app/src/Cell.tsx#Cell']);
  assert.equal(map.unattributed, 1, 'node_modules sources are not attributed');
});

test('reports components it cannot attribute and pages without a React root', () => {
  const orphan = link(component('Provider'), { tag: 5, stateNode: host(0, 0, 10, 10) });
  const foreign = component('Foreign');
  link(foreign, { tag: 5, stateNode: host(0, 0, 10, 10), _debugOwner: foreign, _debugStack: { stack: 'Error\n    at x (https://cdn.example.com/lib.js:1:1)' } });
  const map = collect({ roots: [link({ tag: 3 }, orphan, foreign)], origin: ORIGIN, scrollX: 0, scrollY: 0 });
  assert.deepEqual(map, { components: [], unattributed: 2 });
  assert.deepEqual(collect({ roots: [], origin: ORIGIN, scrollX: 0, scrollY: 0 }), { components: [], unattributed: 0, reason: 'react-root-not-found' });
});
