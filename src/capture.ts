import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, WorkspaceStore } from './store.ts';

type PreviewIdentity = { appId: string; serverId: string; generation: number; readiness: string };
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
};

type PageCapture = (url: string, viewport: { width: number; height: number }) => Promise<Buffer>;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;

function previewDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path);
  if (!lstatSync(path).isDirectory()) throw new Error('Preview path is not a regular directory');
}

function previewUsage(path: string): number {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const image = join(path, entry.name, 'primary.png');
    if (existsSync(image) && lstatSync(image).isFile()) bytes += lstatSync(image).size;
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

async function browserCapture(url: string, viewport: { width: number; height: number }): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
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
    return await page.screenshot({ type: 'png', animations: 'disabled' });
  } finally {
    await browser.close();
  }
}

export async function captureCheckpoint(
  root: string,
  store: WorkspaceStore,
  checkpoint: Checkpoint,
  options: { previewUrl: string; appId: string; route?: string; viewport?: { width: number; height: number }; capturePage?: PageCapture; retrySourceOnly?: boolean },
): Promise<PreviewRecord> {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const route = options.route ?? '/';
  const record: PreviewRecord = {
    checkpointId: checkpoint.id,
    status: 'source_only',
    attempts: 1,
    sourceDigest: checkpoint.digest,
    appId: options.appId,
    route,
    viewport,
    fidelityLimits: ['Excluded dependencies, environment variables, network data and runtime state may affect pixels.'],
  };
  if (!/^[a-f0-9-]{36}$/.test(checkpoint.id)) throw new Error('Invalid checkpoint ID');
  const previews = join(root, '.rewindry', 'previews');
  previewDirectory(previews);
  const target = join(previews, checkpoint.id);
  previewDirectory(target);
  const recordPath = join(target, 'primary.json');
  if (existsSync(recordPath)) {
    if (!lstatSync(recordPath).isFile()) throw new Error('Preview record is not a regular file');
    const previous = JSON.parse(readFileSync(recordPath, 'utf8')) as PreviewRecord;
    const attempts = Number.isSafeInteger(previous.attempts) ? previous.attempts! : 1;
    if (previous.status === 'captured' || !options.retrySourceOnly || attempts >= 2) return previous;
    record.attempts = attempts + 1;
  }
  try {
    const base = localPreview(options.previewUrl);
    const pageUrl = localPreview(new URL(route, base).toString());
    if (pageUrl.origin !== base.origin) throw new Error('Preview route changed origin');
    const before = await identity(base);
    if (before.appId !== options.appId) throw new Error('Preview app identity mismatch');
    if (store.currentDigest() !== checkpoint.digest) throw new Error('Source moved before capture');
    const bytes = await (options.capturePage ?? browserCapture)(pageUrl.toString(), viewport);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Screenshot exceeded the 4 MiB image limit');
    if (previewUsage(previews) + bytes.length > MAX_PREVIEW_BYTES) {
      throw new Error('Preview storage exceeded the 256 MiB image budget');
    }
    const after = await identity(base);
    if (after.appId !== before.appId || after.serverId !== before.serverId ||
        after.generation !== before.generation) throw new Error('Preview generation changed during capture');
    if (store.currentDigest() !== checkpoint.digest) throw new Error('Source moved during capture');
    record.status = 'captured';
    record.serverId = before.serverId;
    record.generation = before.generation;
    record.previewReadiness = after.readiness;
    record.capturedAt = new Date().toISOString();
    record.fidelityLimits.push(after.readiness === 'idle'
      ? 'Fresh browser render followed Vite request idle; existing-tab HMR state is not attested.'
      : 'Preview did not attest completed HMR rendering.');
    const temporary = join(target, `.${randomUUID()}.png`);
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, join(target, 'primary.png'));
  } catch (error) {
    record.reason = error instanceof Error ? error.message : String(error);
  }
  const temporary = join(target, `.${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
  renameSync(temporary, join(target, 'primary.json'));
  return record;
}
