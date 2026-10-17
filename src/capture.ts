import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import type { Checkpoint, WorkspaceStore } from './store.ts';

type PreviewIdentity = { appId: string; serverId: string; generation: number; readiness: string };
export type PreviewViewport = {
  id: string;
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
};
export type PreviewTargetConfig = {
  id: string;
  label: string;
  route: string;
  selector?: string;
  viewports: PreviewViewport[];
};
export type PreviewTargetRecord = {
  targetId: string;
  targetLabel: string;
  viewportId: string;
  viewportLabel: string;
  route: string;
  selector?: string;
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  status: 'captured' | 'source_only';
  reason?: string;
  imageFile?: string;
};
export type PreviewRecord = {
  checkpointId: string;
  status: 'captured' | 'source_only';
  attempts?: number;
  reason?: string;
  sourceDigest: string;
  appId: string;
  serverId?: string;
  generation?: number;
  previewReadiness?: string;
  route: string;
  viewport: { width: number; height: number };
  capturedAt?: string;
  fidelityLimits: string[];
  targets?: PreviewTargetRecord[];
  primaryTargetId?: string;
  primaryViewportId?: string;
};

type CaptureRequest = {
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  selector?: string;
};
export type PageCapture = (url: string, request: CaptureRequest) => Promise<Buffer>;
type CaptureSession = { capture(url: string, request: CaptureRequest): Promise<Buffer>; close(): Promise<void> };
type CaptureOptions = {
  previewUrl: string;
  appId: string;
  route?: string;
  viewport?: { width: number; height: number };
  targets?: unknown;
  capturePage?: PageCapture;
  retrySourceOnly?: boolean;
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;
const MAX_CAPTURE_VARIANTS = 12;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_ROUTE_LENGTH = 2_048;
const MAX_SELECTOR_LENGTH = 256;

function previewDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path);
  if (!lstatSync(path).isDirectory()) throw new Error('Preview path is not a regular directory');
}

function previewUsage(path: string): number {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(path, entry.name);
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.png')) continue;
      const image = join(directory, name);
      if (existsSync(image) && lstatSync(image).isFile()) bytes += lstatSync(image).size;
    }
  }
  return bytes;
}

function localPreview(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password) throw new Error('Preview must be a local HTTP URL');
  return parsed;
}

async function identity(base: URL): Promise<PreviewIdentity> {
  const endpoint = new URL('/__rewindry/preview', base);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Preview identity HTTP ${response.status}`);
  const value = await response.json() as Partial<PreviewIdentity>;
  if (typeof value.appId !== 'string' || typeof value.serverId !== 'string' ||
      !Number.isSafeInteger(value.generation) || typeof value.readiness !== 'string') {
    throw new Error('Invalid preview identity');
  }
  return value as PreviewIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printableLabel(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`Invalid ${name}: use 1 to 64 printable characters`);
  }
  return value;
}

function normalizedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`Invalid ${name}: use lowercase letters, numbers, and hyphens`);
  return value;
}

function normalizeTargets(options: CaptureOptions): PreviewTargetConfig[] {
  if (options.targets === undefined) {
    const viewport = options.viewport ?? { width: 1280, height: 800 };
    return [{
      id: 'default',
      label: 'Page',
      route: options.route ?? '/',
      viewports: [{ id: 'desktop', label: 'Desktop', ...viewport, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }],
    }];
  }
  if (!Array.isArray(options.targets) || options.targets.length === 0) throw new Error('Preview targets must be a non-empty array');
  const targetIds = new Set<string>();
  const fileNames = new Set<string>();
  let variantCount = 0;
  const targets = options.targets.map((value, index): PreviewTargetConfig => {
    if (!isRecord(value)) throw new Error(`Invalid preview target at index ${index}`);
    const id = normalizedId(value.id, `target ID at index ${index}`);
    if (targetIds.has(id)) throw new Error(`Duplicate preview target ID: ${id}`);
    targetIds.add(id);
    const label = printableLabel(value.label, `target label for ${id}`);
    if (typeof value.route !== 'string' || !value.route || value.route.length > MAX_ROUTE_LENGTH) {
      throw new Error(`Invalid route for preview target ${id}`);
    }
    let selector: string | undefined;
    if (value.selector !== undefined) {
      if (typeof value.selector !== 'string' || !value.selector.trim() || value.selector.length > MAX_SELECTOR_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(value.selector)) {
        throw new Error(`Invalid CSS selector for preview target ${id}`);
      }
      selector = value.selector;
    }
    if (!Array.isArray(value.viewports) || value.viewports.length === 0) {
      throw new Error(`Preview target ${id} needs at least one viewport`);
    }
    const viewportIds = new Set<string>();
    const viewports = value.viewports.map((profile, profileIndex): PreviewViewport => {
      if (!isRecord(profile)) throw new Error(`Invalid viewport at ${id}[${profileIndex}]`);
      const viewportId = normalizedId(profile.id, `viewport ID at ${id}[${profileIndex}]`);
      if (viewportIds.has(viewportId)) throw new Error(`Duplicate viewport ID ${viewportId} in target ${id}`);
      viewportIds.add(viewportId);
      const viewportLabel = printableLabel(profile.label, `viewport label for ${id}/${viewportId}`);
      for (const dimension of ['width', 'height'] as const) {
        if (!Number.isSafeInteger(profile[dimension]) || (profile[dimension] as number) < 1 || (profile[dimension] as number) > 4_096) {
          throw new Error(`Invalid viewport ${dimension} for ${id}/${viewportId}: expected an integer from 1 to 4096`);
        }
      }
      for (const flag of ['isMobile', 'hasTouch'] as const) {
        if (profile[flag] !== undefined && typeof profile[flag] !== 'boolean') {
          throw new Error(`Invalid viewport ${flag} for ${id}/${viewportId}`);
        }
      }
      const deviceScaleFactor = profile.deviceScaleFactor ?? 1;
      if (!Number.isSafeInteger(deviceScaleFactor) || (deviceScaleFactor as number) < 1 || (deviceScaleFactor as number) > 3) {
        throw new Error(`Invalid deviceScaleFactor for ${id}/${viewportId}: expected an integer from 1 to 3`);
      }
      const filename = `${id}--${viewportId}.png`;
      if (fileNames.has(filename)) throw new Error(`Preview target variants produce a duplicate image filename: ${filename}`);
      fileNames.add(filename);
      variantCount++;
      if (variantCount > MAX_CAPTURE_VARIANTS) throw new Error(`Preview configuration exceeds the ${MAX_CAPTURE_VARIANTS}-variant limit`);
      return {
        id: viewportId,
        label: viewportLabel,
        width: profile.width as number,
        height: profile.height as number,
        isMobile: profile.isMobile === true,
        hasTouch: profile.hasTouch === true,
        deviceScaleFactor: deviceScaleFactor as number,
      };
    });
    return { id, label, route: value.route, ...(selector ? { selector } : {}), viewports };
  });
  return targets;
}

function captureRequest(target: PreviewTargetConfig, viewport: PreviewViewport): CaptureRequest {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    deviceScaleFactor: viewport.deviceScaleFactor,
    ...(target.selector ? { selector: target.selector } : {}),
  };
}

async function createCaptureSession(): Promise<CaptureSession> {
  const { chromium } = await import('playwright');
  const browser: Browser = await chromium.launch({ headless: true });
  return {
    async capture(url, request) {
      const context: BrowserContext = await browser.newContext({
        viewport: request.viewport,
        deviceScaleFactor: request.deviceScaleFactor,
        isMobile: request.isMobile,
        hasTouch: request.hasTouch,
        serviceWorkers: 'block',
      });
      try {
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
        if (!response?.ok()) throw new Error(`Preview page HTTP ${response?.status() ?? 'unknown'}`);
        if (errors.length) throw new Error(`Preview page error: ${errors[0]}`);
        if (await page.locator('vite-error-overlay').count()) throw new Error('Vite compiler error overlay is visible');
        await page.locator('#rewindry-overlay-root').evaluateAll((items) => {
          for (const item of items) (item as HTMLElement).style.visibility = 'hidden';
        });
        if (request.selector) {
          const locator = page.locator(`css=${request.selector}`);
          const count = await locator.count();
          if (count !== 1) throw new Error(`Preview selector matched ${count} elements; expected exactly one`);
          return await locator.screenshot({ type: 'png', animations: 'disabled' });
        }
        return await page.screenshot({ type: 'png', animations: 'disabled' });
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}

function legacyTargets(record: PreviewRecord): PreviewTargetRecord[] {
  return [{
    targetId: 'default',
    targetLabel: 'Page',
    viewportId: 'desktop',
    viewportLabel: 'Desktop',
    route: record.route || '/',
    viewport: record.viewport || { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    status: record.status,
    ...(record.status === 'captured' ? { imageFile: 'primary.png' } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  }];
}

export function previewTargetRecords(record: PreviewRecord): PreviewTargetRecord[] {
  return Array.isArray(record.targets) ? record.targets : legacyTargets(record);
}

export async function captureCheckpoint(
  root: string,
  store: WorkspaceStore,
  checkpoint: Checkpoint,
  options: CaptureOptions,
): Promise<PreviewRecord> {
  const initialViewport = options.viewport ?? { width: 1280, height: 800 };
  const initialRoute = options.route ?? '/';
  const record: PreviewRecord = {
    checkpointId: checkpoint.id,
    status: 'source_only',
    attempts: 1,
    sourceDigest: checkpoint.digest,
    appId: options.appId,
    route: initialRoute,
    viewport: initialViewport,
    fidelityLimits: ['Excluded dependencies, environment variables, network data and runtime state may affect pixels.'],
  };
  if (!/^[a-f0-9-]{36}$/.test(checkpoint.id)) throw new Error('Invalid checkpoint ID');
  const previews = join(root, '.rewindry', 'previews');
  previewDirectory(previews);
  const targetDirectory = join(previews, checkpoint.id);
  previewDirectory(targetDirectory);
  const recordPath = join(targetDirectory, 'primary.json');
  if (existsSync(recordPath)) {
    if (!lstatSync(recordPath).isFile()) throw new Error('Preview record is not a regular file');
    const previous = JSON.parse(readFileSync(recordPath, 'utf8')) as PreviewRecord;
    const attempts = Number.isSafeInteger(previous.attempts) ? previous.attempts! : 1;
    if (previous.status === 'captured' || !options.retrySourceOnly || attempts >= 2) return previous;
    record.attempts = attempts + 1;
  }

  const staged: Array<{ record: PreviewTargetRecord; bytes: Buffer }> = [];
  let session: CaptureSession | undefined;
  try {
    const configs = normalizeTargets(options);
    const first = configs[0]!;
    const firstViewport = first.viewports[0]!;
    record.route = first.route;
    record.viewport = { width: firstViewport.width, height: firstViewport.height };
    record.targets = configs.flatMap((target) => target.viewports.map((viewport) => ({
      targetId: target.id,
      targetLabel: target.label,
      viewportId: viewport.id,
      viewportLabel: viewport.label,
      route: target.route,
      ...(target.selector ? { selector: target.selector } : {}),
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      deviceScaleFactor: viewport.deviceScaleFactor,
      status: 'source_only' as const,
    })));

    const base = localPreview(options.previewUrl);
    const targetUrls = configs.map((target) => {
      const url = localPreview(new URL(target.route, base).toString());
      if (url.origin !== base.origin) throw new Error(`Preview route for ${target.id} changed origin`);
      return url;
    });
    const before = await identity(base);
    if (before.appId !== options.appId) throw new Error('Preview app identity mismatch');
    if (store.currentDigest() !== checkpoint.digest) throw new Error('Source moved before capture');

    if (!options.capturePage) session = await createCaptureSession();
    let usedBytes = previewUsage(previews);
    for (let targetIndex = 0; targetIndex < configs.length; targetIndex++) {
      const target = configs[targetIndex]!;
      for (const viewport of target.viewports) {
        const targetRecord = record.targets!.find((item) => item.targetId === target.id && item.viewportId === viewport.id)!;
        try {
          const request = captureRequest(target, viewport);
          const bytes = await (options.capturePage ?? session!.capture.bind(session))(targetUrls[targetIndex]!.toString(), request);
          if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Screenshot exceeded the 4 MiB image limit');
          if (usedBytes + bytes.length > MAX_PREVIEW_BYTES) throw new Error('Preview storage exceeded the 256 MiB image budget');
          usedBytes += bytes.length;
          targetRecord.status = 'captured';
          staged.push({ record: targetRecord, bytes });
        } catch (error) {
          targetRecord.reason = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
        }
      }
    }

    const after = await identity(base);
    if (after.appId !== before.appId || after.serverId !== before.serverId ||
        after.generation !== before.generation) throw new Error('Preview generation changed during capture');
    if (store.currentDigest() !== checkpoint.digest) throw new Error('Source moved during capture');

    if (staged.length) {
      const primary = staged[0]!.record;
      record.status = 'captured';
      record.route = primary.route;
      record.viewport = primary.viewport;
      record.primaryTargetId = primary.targetId;
      record.primaryViewportId = primary.viewportId;
      record.serverId = before.serverId;
      record.generation = before.generation;
      record.previewReadiness = after.readiness;
      record.capturedAt = new Date().toISOString();
      record.fidelityLimits.push(after.readiness === 'idle'
        ? 'Fresh browser render followed Vite request idle; existing-tab HMR state is not attested.'
        : 'Preview did not attest completed HMR rendering.');
      const published: string[] = [];
      const temporaryFiles: string[] = [];
      try {
        for (let index = 0; index < staged.length; index++) {
          const item = staged[index]!;
          item.record.imageFile = index === 0 ? 'primary.png' : `${item.record.targetId}--${item.record.viewportId}.png`;
          const temporary = join(targetDirectory, `.${randomUUID()}.png`);
          writeFileSync(temporary, item.bytes, { flag: 'wx' });
          temporaryFiles.push(temporary);
          const finalPath = join(targetDirectory, item.record.imageFile);
          renameSync(temporary, finalPath);
          published.push(finalPath);
        }
      } catch (error) {
        for (const path of temporaryFiles) rmSync(path, { force: true });
        for (const path of published) rmSync(path, { force: true });
        throw error;
      }
    } else {
      record.reason = record.targets?.map((target) => target.reason).find(Boolean) ?? 'No configured preview targets were captured.';
    }
  } catch (error) {
    record.status = 'source_only';
    record.reason = error instanceof Error ? error.message : String(error);
    for (const target of record.targets ?? []) {
      target.status = 'source_only';
      delete target.imageFile;
      target.reason = record.reason.slice(0, 512);
    }
  } finally {
    await session?.close();
  }

  const temporary = join(targetDirectory, `.${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
  renameSync(temporary, recordPath);
  return record;
}
