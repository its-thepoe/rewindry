import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

export type ComponentBox = { x: number; y: number; width: number; height: number };
export type ComponentInstance = { key: string; file: string; component: string; occurrence: number; box: ComponentBox };
export type ComponentMap = { components: ComponentInstance[]; unattributed: number; reason?: 'react-root-not-found' };
export type ComponentMapOptions = { roots?: unknown[]; origin?: string; scrollX?: number; scrollY?: number };

let script: string | undefined;

// The collector stays plain JS so test/build transforms cannot inject helpers it cannot see in the page.
export function componentMapScript(): string {
  script ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'component-collector.js'), 'utf8')
    .replace(/^(\s*\/\/[^\n]*\n)+/, '').trim();
  return script;
}

export async function collectComponentMap(page: Page): Promise<ComponentMap> {
  return await page.evaluate(`(${componentMapScript()})()`) as ComponentMap;
}
