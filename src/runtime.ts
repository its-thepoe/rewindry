import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { captureCheckpoint, type PageCapture, type PreviewRecord } from './capture.ts';
import { WorkspaceObserver } from './observer.ts';
import { WorkspaceStore, type Checkpoint } from './store.ts';
import { TurnManager, type AgentEvent, type Clock } from './turn-manager.ts';
import { captureUiHistory, type FrameRenderer, type UiCaptureSummary } from './ui-capture.ts';

type PreviewSettings = {
  url: string; appId: string; route?: string; targets?: unknown; profiles?: unknown; capturePage?: PageCapture;
  // Per-screen history runs for configured projects; an injected preview opts in by supplying a renderer.
  uiRenderer?: FrameRenderer; uiHistory?: boolean;
};

export class RewindryRuntime {
  readonly store: WorkspaceStore;
  readonly turns: TurnManager;
  readonly observer: WorkspaceObserver;
  readonly workspaceId: string;
  observedWrites = 0;
  readonly captureResults = new Map<string, PreviewRecord>();
  readonly uiCaptureResults = new Map<string, UiCaptureSummary | Error>();
  private readonly captureJobs = new Map<string, Promise<PreviewRecord>>();
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly root: string;
  private readonly previewOverride?: PreviewSettings;

  constructor(root: string, options?: {
    clock?: Clock; manualQuietMs?: number; settleMs?: number; staleTurnMs?: number; rescanIntervalMs?: number;
    preview?: PreviewSettings;
  }) {
    const canonicalRoot = realpathSync(root);
    this.root = canonicalRoot;
    this.previewOverride = options?.preview;
    this.workspaceId = createHash('sha256').update(canonicalRoot).digest('hex');
    this.store = new WorkspaceStore(canonicalRoot);
    this.store.initialize();
    this.turns = new TurnManager(
      this.workspaceId,
      { snapshot: (kind, key, metadata) => {
        const checkpoint = this.store.snapshot(kind, key, metadata);
        if (checkpoint) this.queueCapture(checkpoint);
        return checkpoint;
      } },
      join(canonicalRoot, '.rewindry', 'journal', 'events.jsonl'),
      options?.clock,
      options?.manualQuietMs,
      options?.settleMs,
      options?.staleTurnMs,
    );
    this.observer = new WorkspaceObserver(canonicalRoot, () => {
      this.observedWrites++;
      this.turns.onWrite();
    }, { digest: () => this.store.currentDigest(), rescanIntervalMs: options?.rescanIntervalMs });
  }

  async start(): Promise<void> {
    if (this.store.list().length === 0) this.store.snapshot('baseline');
    else if (this.store.list().at(-1)?.digest !== this.store.currentDigest()) this.turns.onWrite();
    await this.observer.start();
  }

  ingest(event: AgentEvent): boolean {
    return this.turns.ingest(event);
  }

  queueCapture(checkpoint: Checkpoint, retrySourceOnly = false): Promise<PreviewRecord> | null {
    const preview = this.currentPreview();
    if (!preview) return null;
    const pending = this.captureJobs.get(checkpoint.id);
    if (pending) return pending;
    const job = captureCheckpoint(this.root, this.store, checkpoint, {
      previewUrl: preview.url,
      appId: preview.appId,
      route: preview.route,
      targets: preview.targets,
      capturePage: preview.capturePage,
      retrySourceOnly,
    }).then((record) => {
      this.captureResults.set(checkpoint.id, record);
      if (record.status === 'captured' && (preview.uiRenderer || preview.uiHistory)) void this.queueUiHistory(checkpoint, preview);
      return record;
    }).finally(() => this.captureJobs.delete(checkpoint.id));
    this.captureJobs.set(checkpoint.id, job);
    return job;
  }

  // One background browser at a time: per-screen captures for successive updates run in order.
  private queueUiHistory(checkpoint: Checkpoint, preview: PreviewSettings): Promise<void> {
    const run = this.uiQueue.then(async () => {
      try {
        this.uiCaptureResults.set(checkpoint.id, await captureUiHistory(this.root, this.store, checkpoint, {
          previewUrl: preview.url, appId: preview.appId, route: preview.route, profiles: preview.profiles, renderer: preview.uiRenderer,
        }));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.uiCaptureResults.set(checkpoint.id, failure);
        console.warn(`Rewindry screen history capture failed: ${failure.message}`);
      }
    });
    this.uiQueue = run;
    return run;
  }

  private currentPreview(): PreviewSettings | undefined {
    if (this.previewOverride) return this.previewOverride;
    const configPath = join(this.root, '.rewindry', 'config.json');
    if (!existsSync(configPath)) return undefined;
    try {
      const configured = JSON.parse(readFileSync(configPath, 'utf8')) as {
        preview?: { url?: unknown; appId?: unknown; route?: unknown; targets?: unknown; profiles?: unknown };
      };
      const preview = configured.preview;
      if (typeof preview?.url !== 'string' || typeof preview.appId !== 'string') return undefined;
      return {
        url: preview.url,
        appId: preview.appId,
        ...(typeof preview.route === 'string' ? { route: preview.route } : {}),
        ...(preview.targets !== undefined ? { targets: preview.targets } : {}),
        ...(preview.profiles !== undefined ? { profiles: preview.profiles } : {}),
        uiHistory: true,
      };
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.observer.close();
    this.turns.close();
    await Promise.allSettled(this.captureJobs.values());
    await this.uiQueue;
  }

  // Resolves once every per-screen capture queued so far has finished.
  async uiHistoryIdle(): Promise<void> {
    await this.uiQueue;
  }
}
