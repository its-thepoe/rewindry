import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { identity, localPreview, previewUsage } from './capture.ts';
import { collectComponentMap, type ComponentInstance } from './component-map.ts';
import { cropImage, decodePng, encodePng } from './png.ts';
import type { Checkpoint, ComponentVersionInput, UiState, WorkspaceStore } from './store.ts';
import { LANDING_SET, type InteractionStep, type Locator } from './ui-states.ts';

export type CaptureProfile = {
  id: string; label: string; width: number; height: number; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number;
};
export const DEFAULT_PROFILES: CaptureProfile[] = [
  { id: 'mobile', label: 'Mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];
export const MAX_FRAMES_PER_CHECKPOINT = 36;
const MAX_PROFILES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VISUAL_BYTES = 256 * 1024 * 1024;
const MAX_COMPONENTS_PER_FRAME = 400;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type RenderResult =
  | { status: 'captured'; png: Buffer; components: ComponentInstance[] }
  | { status: 'path_broken' | 'failed'; reason: string };
export type FrameRenderer = {
  render(url: string, profile: CaptureProfile, path: InteractionStep[]): Promise<RenderResult>;
  close(): Promise<void>;
};
export type UiCaptureOptions = {
  previewUrl: string; appId: string; route?: string; profiles?: unknown; renderer?: FrameRenderer; maxFrames?: number;
};
export type UiCaptureSummary = {
  states: number; captured: number; unchanged: number; pathBroken: number; failed: number; skipped: number;
};

export function normalizeProfiles(value: unknown): CaptureProfile[] {
  if (value === undefined) return DEFAULT_PROFILES;
  if (!Array.isArray(value) || !value.length || value.length > MAX_PROFILES) throw new Error(`Preview profiles must be 1 to ${MAX_PROFILES} entries`);
  const ids = new Set<string>();
  return value.map((item, index) => {
    const profile = item as Partial<CaptureProfile> | null;
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || !PROFILE_ID.test(profile.id) || ids.has(profile.id)) {
      throw new Error(`Invalid preview profile ID at index ${index}`);
    }
    ids.add(profile.id);
    const label = profile.label ?? profile.id;
    if (typeof label !== 'string' || !label || label.length > 64) throw new Error(`Invalid label for profile ${profile.id}`);
    for (const dimension of ['width', 'height'] as const) {
      const size = profile[dimension];
      if (!Number.isSafeInteger(size) || size! < 1 || size! > 4_096) throw new Error(`Invalid ${dimension} for profile ${profile.id}`);
    }
    const deviceScaleFactor = profile.deviceScaleFactor ?? 1;
    if (!Number.isSafeInteger(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 3) {
      throw new Error(`Invalid deviceScaleFactor for profile ${profile.id}`);
    }
    for (const flag of ['isMobile', 'hasTouch'] as const) {
      if (profile[flag] !== undefined && typeof profile[flag] !== 'boolean') throw new Error(`Invalid ${flag} for profile ${profile.id}`);
    }
    return {
      id: profile.id, label, width: profile.width!, height: profile.height!,
      isMobile: profile.isMobile === true, hasTouch: profile.hasTouch === true, deviceScaleFactor,
    };
  });
}

// Files whose bytes differ from the previous checkpoint, including additions and deletions.
export function changedFiles(store: WorkspaceStore, checkpoint: Checkpoint): Set<string> {
  const checkpoints = store.list();
  const index = checkpoints.findIndex((item) => item.id === checkpoint.id);
  const previous = index > 0 ? new Map(checkpoints[index - 1]!.files.map((file) => [file.path, file.digest])) : new Map<string, string>();
  const changed = new Set<string>();
  for (const file of checkpoint.files) {
    if (previous.get(file.path) !== file.digest) changed.add(file.path);
    previous.delete(file.path);
  }
  for (const path of previous.keys()) changed.add(path);
  return changed;
}

const componentFile = (key: string) => key.slice(0, key.lastIndexOf('#'));

// States that render a changed file come first; the landing page is always included. When a
// change touches no known state (a global stylesheet, say), the most recently used states stand in.
export function selectStates(states: UiState[], changed: Set<string>, landingId: string, maxStates: number): { selected: UiState[]; skipped: UiState[] } {
  const touches = (state: UiState) => state.components.some((key) => changed.has(componentFile(key))) || state.modules.some((path) => changed.has(path));
  const matched = states.filter((state) => state.id !== landingId && touches(state));
  const landing = states.find((state) => state.id === landingId);
  const ordered = matched.length ? matched : states.filter((state) => state.id !== landingId);
  const candidates = [...(landing ? [landing] : []), ...ordered];
  return {
    selected: candidates.slice(0, maxStates),
    // Only states this change actually touched are reported as skipped; untouched ones simply wait.
    skipped: matched.length ? candidates.slice(maxStates) : [],
  };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function captureUiHistory(root: string, store: WorkspaceStore, checkpoint: Checkpoint, options: UiCaptureOptions): Promise<UiCaptureSummary> {
  const summary: UiCaptureSummary = { states: 0, captured: 0, unchanged: 0, pathBroken: 0, failed: 0, skipped: 0 };
  const base = localPreview(options.previewUrl);
  const profiles = normalizeProfiles(options.profiles);
  const route = options.route ?? '/';
  if (!route.startsWith('/')) throw new Error('Preview route must start with /');
  const maxStates = Math.max(1, Math.floor((options.maxFrames ?? MAX_FRAMES_PER_CHECKPOINT) / profiles.length));

  // The landing page always has history, even if no browser has ever opened the app.
  if (!store.listUiStates().some((state) => state.route === route && state.componentSet === LANDING_SET)) {
    store.upsertUiState({ origin: 'configured', route, path: [], componentSet: LANDING_SET });
  }
  const states = store.listUiStates();
  const landing = states.find((state) => state.route === route && state.componentSet === LANDING_SET)!;
  const { selected, skipped } = selectStates(states, changedFiles(store, checkpoint), landing.id, maxStates);
  summary.states = selected.length;

  const before = await identity(base);
  if (before.appId !== options.appId) throw new Error('Preview app identity mismatch');
  if (store.currentDigest() !== checkpoint.digest) throw new Error('Source moved before capture');

  const renders: { state: UiState; profile: CaptureProfile; result: RenderResult }[] = [];
  const renderer = options.renderer ?? await createFrameRenderer();
  try {
    for (const state of selected) {
      const url = localPreview(new URL(state.route, base).toString());
      if (url.origin !== base.origin) throw new Error('UI state route changed origin');
      for (const profile of profiles) {
        if (store.hasScreenFrame(checkpoint.id, state.id, profile.id)) continue;
        renders.push({ state, profile, result: await renderer.render(url.toString(), profile, state.path as InteractionStep[]) });
      }
    }
  } finally {
    if (!options.renderer) await renderer.close();
  }

  // Nothing is published if the source or the dev server moved underneath the renders.
  const after = await identity(base);
  if (after.serverId !== before.serverId || after.generation !== before.generation || store.currentDigest() !== checkpoint.digest) {
    throw new Error('Source moved during capture');
  }

  const previews = join(root, '.rewindry', 'previews');
  let usedBytes = store.visualStorageBytes() + (existsSync(previews) ? previewUsage(previews) : 0);
  const brokenStates = new Set<string>();
  for (const { state, profile, result } of renders) {
    const frame = { checkpointId: checkpoint.id, stateId: state.id, profileId: profile.id, captureMode: 'live' as const };
    if (result.status !== 'captured') {
      store.recordScreenFrame({ ...frame, status: result.status, reason: result.reason });
      if (result.status === 'path_broken') brokenStates.add(state.id);
      summary[result.status === 'path_broken' ? 'pathBroken' : 'failed']++;
      continue;
    }
    try {
      if (result.png.length > MAX_IMAGE_BYTES) throw new Error('Screen image exceeds 4 MiB');
      const imageDigest = sha256(result.png);
      const previous = store.previousFrameImage(checkpoint.id, state.id, profile.id);
      const unchanged = previous?.imageDigest === imageDigest;
      const pending = new Map<string, Buffer>();
      if (!unchanged) pending.set(imageDigest, result.png);

      const image = decodePng(result.png);
      const scale = profile.deviceScaleFactor;
      const previousCrops = store.previousComponentCrops(checkpoint.id, state.id, profile.id);
      const components: ComponentVersionInput[] = [];
      for (const instance of result.components.slice(0, MAX_COMPONENTS_PER_FRAME)) {
        const crop = cropImage(image, {
          x: instance.box.x * scale, y: instance.box.y * scale, width: instance.box.width * scale, height: instance.box.height * scale,
        });
        if (!crop) continue;
        const bytes = encodePng(crop);
        const cropDigest = sha256(bytes);
        const prior = previousCrops.get(`${instance.key}@${instance.occurrence}`);
        const same = prior?.cropDigest === cropDigest;
        if (!same) pending.set(cropDigest, bytes);
        components.push({
          componentKey: instance.key, occurrence: instance.occurrence, cropDigest, box: instance.box,
          ...(same ? { unchangedFrom: prior!.unchangedFrom ?? prior!.checkpointId } : {}),
        });
      }
      const newBytes = [...pending.values()].reduce((total, bytes) => total + bytes.length, 0);
      if (usedBytes + newBytes > MAX_VISUAL_BYTES) throw new Error('Visual storage budget exceeded (256 MiB)');
      for (const bytes of pending.values()) store.writeVisual(bytes);
      usedBytes += newBytes;
      store.recordScreenFrame({
        ...frame, status: unchanged ? 'unchanged' : 'captured', imageDigest, components,
        ...(unchanged ? { unchangedFrom: previous!.unchangedFrom ?? previous!.checkpointId } : {}),
      });
      store.updateUiStateComponents(state.id, [...new Set(result.components.map((item) => item.key))].sort());
      summary[unchanged ? 'unchanged' : 'captured']++;
    } catch (error) {
      store.recordScreenFrame({ ...frame, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      summary.failed++;
    }
  }
  // A state is broken only if no profile could follow its path; a working profile keeps it active.
  for (const state of selected) {
    const followed = renders.some((item) => item.state.id === state.id && item.result.status !== 'path_broken');
    if (brokenStates.has(state.id) && !followed) store.markUiStatePathBroken(state.id);
    else if (followed && state.status === 'path_broken') store.setUiStateStatus(state.id, 'active');
  }
  for (const state of skipped) {
    for (const profile of profiles) {
      if (store.hasScreenFrame(checkpoint.id, state.id, profile.id)) continue;
      store.recordScreenFrame({
        checkpointId: checkpoint.id, stateId: state.id, profileId: profile.id, status: 'skipped', captureMode: 'live',
        reason: `Over the ${options.maxFrames ?? MAX_FRAMES_PER_CHECKPOINT}-frame budget for one update`,
      });
      summary.skipped++;
    }
  }
  return summary;
}

const SETTLE_SCRIPT = `new Promise((resolve) => {
  let quiet;
  const finish = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(limit); requestAnimationFrame(() => requestAnimationFrame(resolve)); };
  const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 300); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  quiet = setTimeout(finish, 300);
  const limit = setTimeout(finish, 2000);
})`;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
  await page.evaluate(SETTLE_SCRIPT);
}

function locatorFor(page: Page, candidate: Locator) {
  if (candidate.by === 'testid') return page.getByTestId(candidate.value);
  if (candidate.by === 'role') return page.getByRole(candidate.role as Parameters<Page['getByRole']>[0], { name: candidate.name, exact: true });
  return page.locator(`css=${candidate.value}`);
}

// Tries each recorded locator in turn; a candidate that is missing, ambiguous or not actionable falls through.
async function perform(page: Page, step: InteractionStep): Promise<boolean> {
  if (step.action === 'key') {
    await page.keyboard.press(step.key);
    return true;
  }
  for (const candidate of step.target) {
    const locator = locatorFor(page, candidate);
    const count = await locator.count();
    if (!count) continue;
    const target = count === 1 ? locator.first() : count > candidate.index ? locator.nth(candidate.index) : null;
    if (!target) continue;
    try {
      if (step.action === 'select') await target.selectOption({ index: step.option.index }, { timeout: 2_000 });
      else await target.click({ timeout: 2_000 });
      return true;
    } catch { /* Try the next locator. */ }
  }
  return false;
}

export async function createFrameRenderer(): Promise<FrameRenderer> {
  const { chromium } = await import('playwright');
  const browser: Browser = await chromium.launch({ headless: true });
  return {
    async render(url, profile, path) {
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile, hasTouch: profile.hasTouch, serviceWorkers: 'block',
      });
      try {
        await context.addInitScript('globalThis.__rewindryCapture = true;');
        await context.route('**/*', (route) => {
          try {
            localPreview(route.request().url());
            void route.continue();
          } catch {
            void route.abort();
          }
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 10_000 });
        if (!response?.ok()) return { status: 'failed', reason: `Preview page HTTP ${response?.status() ?? 'unknown'}` };
        await settle(page);
        for (const [index, step] of path.entries()) {
          if (!await perform(page, step)) return { status: 'path_broken', reason: `Step ${index + 1} of ${path.length}: no recorded locator matched` };
          await settle(page);
        }
        if (errors.length) return { status: 'failed', reason: `Preview page error: ${errors[0]!.slice(0, 400)}` };
        if (await page.locator('vite-error-overlay').count()) return { status: 'failed', reason: 'Vite compiler error overlay is visible' };
        await page.evaluate(`(() => {
          for (const item of document.querySelectorAll('#rewindry-overlay-root')) item.style.visibility = 'hidden';
          window.scrollTo(0, 0);
        })()`);
        await settle(page);
        // Document coordinates at scroll 0 line up with the full-page image.
        const map = await collectComponentMap(page).catch(() => ({ components: [] as ComponentInstance[] }));
        const png = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
        return { status: 'captured', png, components: map.components };
      } catch (error) {
        return { status: 'failed', reason: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400) };
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}
