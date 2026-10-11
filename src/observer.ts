import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

const IGNORED_DIRS = new Set(['.rewindry', '.git', 'node_modules', 'dist', 'build', 'coverage']);

export class WorkspaceObserver {
  private watcher?: FSWatcher;
  private readonly root: string;
  private rescanTimer?: NodeJS.Timeout;
  private lastDigest?: string;
  readonly diagnostics: string[] = [];

  constructor(
    root: string,
    private readonly onWrite: () => void,
    private readonly options: { digest?: () => string; rescanIntervalMs?: number } = {},
  ) {
    this.root = realpathSync(root);
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    if (this.options.digest) this.lastDigest = this.options.digest();
    const watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path, stats) => {
        const rel = relative(this.root, path);
        if (!rel || rel.startsWith(`..${sep}`)) return false;
        const parts = rel.split(sep);
        return parts.some((part) => IGNORED_DIRS.has(part) || part === '.env' || part.startsWith('.env.')) ||
          (stats?.isFile() === true && /(?:secret|credential|private[-_]?key)/i.test(rel));
      },
    });
    this.watcher = watcher;
    watcher.on('all', (event) => {
      if (event === 'add' || event === 'change' || event === 'unlink') {
        if (this.options.digest) this.rescan();
        else this.onWrite();
      }
    });
    watcher.on('error', (error) => {
      this.diagnostics.push(`watcher_error:${String(error)}`);
      this.rescan();
    });
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    this.rescan();
    if (this.options.digest) {
      this.rescanTimer = setInterval(() => this.rescan(), this.options.rescanIntervalMs ?? 30_000);
      this.rescanTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    await watcher?.close();
  }

  private rescan(): void {
    if (!this.options.digest) return;
    try {
      const digest = this.options.digest();
      if (this.lastDigest !== undefined && this.lastDigest !== digest) this.onWrite();
      this.lastDigest = digest;
    } catch (error) {
      this.diagnostics.push(`rescan_error:${String(error)}`);
    }
  }
}
