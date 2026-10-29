import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { migrateCheckpointFiles } from "./migration-002-checkpoint-files.ts";
import { migrateUiHistory } from "./migration-003-ui-history.ts";

export type CheckpointKind = "baseline" | "agent_turn" | "unattributed_group";
export type CheckpointFile = { path: string; digest: string; size: number };
export type Checkpoint = {
  id: string;
  kind: CheckpointKind;
  createdAt: string;
  digest: string;
  files: CheckpointFile[];
  turnKey?: string;
  overlap?: boolean;
  checkoutId?: string;
  appId?: string | null;
  uncapturedInputClasses?: string[];
};

export type UiStateOrigin = "learned" | "configured";
export type UiState = {
  id: string;
  origin: UiStateOrigin;
  route: string;
  path: unknown[];
  componentSet: string;
  components: string[];
  modules: string[];
  status: "active" | "path_broken";
  firstSeenAt: string;
  lastSeenAt: string;
};
export type UiStateInput = {
  origin: UiStateOrigin; route: string; path: unknown[]; componentSet: string; components?: string[]; modules?: string[];
};
export type FrameStatus = "captured" | "unchanged" | "path_broken" | "skipped" | "failed";
export type VisualBox = { x: number; y: number; width: number; height: number };
export type ComponentVersionInput = {
  componentKey: string; occurrence: number; cropDigest: string; unchangedFrom?: string; box: VisualBox;
};
export type ScreenFrameInput = {
  checkpointId: string; stateId: string; profileId: string; status: FrameStatus; captureMode: "live" | "replayed";
  imageDigest?: string; unchangedFrom?: string; reason?: string; components?: ComponentVersionInput[];
};
export type ScreenFrame = Omit<ScreenFrameInput, "components"> & { capturedAt: string };
export type ComponentVersion = ComponentVersionInput & { checkpointId: string; stateId: string; profileId: string; captureMode: "live" | "replayed" };

type Manifest = Checkpoint & { schemaVersion: 1; includePolicyVersion: 1 };
type CapturedFile = CheckpointFile & { bytes: Buffer };

const DEFAULT_INCLUDE = [
  "src/**", "public/**", "app/**", "pages/**", "components/**", "styles/**",
  "assets/**", "lib/**", "client/**", "index.html", "package.json", "*lock*",
  "vite.config.*", "postcss.config.*", "tailwind.config.*", "tsconfig*.json",
  "jsconfig*.json", "*.config.css", "*.css",
];
// `preview.viteConfig` names a project's Vite config when it is not `vite.config.*`, such as
// `vite.demo-site.config.ts`. It must be a plain project-relative script path.
const VITE_CONFIG_PATH = /^(?![./])(?!.*\.\.)[\w.-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]s)$/;
export const VITE_CONFIG_LOADERS = ["bundle", "runner", "native"] as const;
export type ViteConfigChoice = { file?: string; loader?: (typeof VITE_CONFIG_LOADERS)[number] };

export function namedViteConfig(preview: { viteConfig?: unknown; viteConfigLoader?: unknown } | undefined): ViteConfigChoice {
  const choice: ViteConfigChoice = {};
  if (preview?.viteConfig !== undefined) {
    if (typeof preview.viteConfig !== "string" || preview.viteConfig.length > 200 || !VITE_CONFIG_PATH.test(preview.viteConfig)) {
      throw new Error("Invalid preview.viteConfig: use a project-relative .ts or .js path");
    }
    choice.file = preview.viteConfig;
  }
  if (preview?.viteConfigLoader !== undefined) {
    if (!VITE_CONFIG_LOADERS.includes(preview.viteConfigLoader as never)) {
      throw new Error(`Invalid preview.viteConfigLoader: use ${VITE_CONFIG_LOADERS.join(", ")}`);
    }
    choice.loader = preview.viteConfigLoader as ViteConfigChoice["loader"];
  }
  return choice;
}

const DEFAULT_EXCLUDE = [".rewindry/**", ".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FRAME_STATUSES = ["captured", "unchanged", "path_broken", "skipped", "failed"];
const MAX_STATE_PATH_BYTES = 64 * 1024;
const MAX_STATE_MODULES = 2_000;
const UNCAPTURED_INPUT_CLASSES = [
  "private or excluded files", "installed dependencies and build output",
  "browser and process state", "remote services",
];

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function atomicWrite(path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: "wx" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function isPrivatePath(path: string): boolean {
  return path.split("/").some((part) =>
    part === ".env" || part.startsWith(".env.") ||
    /(?:secret|credential|private[-_]?key)/i.test(part) ||
    /\.(?:pem|p12|pfx|key)$/i.test(part),
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class WorkspaceStore {
  private readonly root: string;
  private readonly storage: string;
  private db?: DatabaseSync;
  private include = DEFAULT_INCLUDE;
  private exclude = DEFAULT_EXCLUDE;
  private maxFileBytes = MAX_FILE_BYTES;
  private maxSourceBytes = MAX_SOURCE_BYTES;

  constructor(root: string) {
    this.root = realpathSync(root);
    this.storage = join(this.root, ".rewindry");
  }

  initialize(): void {
    if (existsSync(this.storage) && lstatSync(this.storage).isSymbolicLink()) {
      throw new Error("Storage directory cannot be a symlink");
    }
    mkdirSync(this.storage, { recursive: true });
    for (const name of ["objects", "manifests"]) {
      const path = join(this.storage, name);
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        throw new Error(`Storage ${name} cannot be a symlink`);
      }
      mkdirSync(path, { recursive: true });
    }
    const configPath = join(this.storage, "config.json");
    if (existsSync(configPath)) {
      if (!lstatSync(configPath).isFile()) throw new Error("Invalid store config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        capture?: { include?: unknown; exclude?: unknown; maxFileBytes?: unknown; maxSourceBytes?: unknown };
        preview?: { viteConfig?: unknown; viteConfigLoader?: unknown };
      };
      const capture = config.capture;
      if (capture?.include !== undefined) this.include = this.readPatterns(capture.include);
      // A named Vite config is saved with each checkpoint so backfill can serve old source with it.
      const viteConfig = namedViteConfig(config.preview).file;
      if (viteConfig && !this.include.includes(viteConfig)) this.include = [...this.include, viteConfig];
      if (capture?.exclude !== undefined) this.exclude = [...DEFAULT_EXCLUDE, ...this.readPatterns(capture.exclude)];
      if (capture?.maxFileBytes !== undefined) {
        if (!Number.isSafeInteger(capture.maxFileBytes) || (capture.maxFileBytes as number) < 1) {
          throw new Error("Invalid maxFileBytes");
        }
        this.maxFileBytes = capture.maxFileBytes as number;
      }
      if (capture?.maxSourceBytes !== undefined) {
        if (!Number.isSafeInteger(capture.maxSourceBytes) || (capture.maxSourceBytes as number) < 1) {
          throw new Error("Invalid maxSourceBytes");
        }
        this.maxSourceBytes = capture.maxSourceBytes as number;
      }
    }
    this.db?.close();
    const indexPath = join(this.storage, "index.sqlite");
    if (existsSync(indexPath) && lstatSync(indexPath).isSymbolicLink()) {
      throw new Error("Store index cannot be a symlink");
    }
    const db = new DatabaseSync(indexPath);
    // The Vite plugin and the daemon can both write; wait briefly for the other's lock instead of failing.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 3) {
      db.close();
      throw new Error(`Unsupported store schema version ${version.user_version}`);
    }
    if (version.user_version === 0) db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        digest TEXT NOT NULL,
        turn_key TEXT,
        manifest_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_created_at ON checkpoints(created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS checkpoints_turn_key ON checkpoints(turn_key) WHERE turn_key IS NOT NULL;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    this.db = db;
    try {
      if (version.user_version < 2) migrateCheckpointFiles(db, (id) =>
        this.readManifestAt(join(this.storage, "manifests", `${id}.json`), id).files);
      if (version.user_version < 3) migrateUiHistory(db);
    } catch (error) {
      this.db = undefined;
      db.close();
      throw error;
    }
  }

  snapshot(kind: CheckpointKind, turnKey?: string, metadata?: { overlap?: boolean }): Checkpoint | null {
    const db = this.database();
    if (!(["baseline", "agent_turn", "unattributed_group"] as string[]).includes(kind)) {
      throw new Error("Invalid checkpoint kind");
    }
    if (turnKey !== undefined && (!turnKey || kind !== "agent_turn")) {
      throw new Error("turnKey requires an agent turn");
    }
    if (metadata?.overlap && kind !== "unattributed_group") throw new Error("Overlap requires a grouped checkpoint");
    if (turnKey && db.prepare("SELECT id FROM checkpoints WHERE turn_key = ?").get(turnKey)) return null;

    let files = this.scan();
    // A write during enumeration must not publish a mixed tree.
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = this.scan();
      if (this.treeDigest(files) === this.treeDigest(next)) break;
      if (attempt === 2) throw new Error("Source changed while creating checkpoint");
      files = next;
    }
    const digest = this.treeDigest(files);
    const latest = db.prepare("SELECT digest FROM checkpoints ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as
      | { digest: string } | undefined;
    if (latest?.digest === digest) return null;

    const newObjects = new Map(files.map((file) => [file.digest, file.size]));
    for (const objectDigest of newObjects.keys()) {
      if (existsSync(this.objectPath(objectDigest))) newObjects.delete(objectDigest);
    }
    const neededBytes = [...newObjects.values()].reduce((total, size) => total + size, 0);
    if (this.sourceStorageBytes() + neededBytes > this.maxSourceBytes) {
      throw new Error(`Source storage budget exceeded (${this.maxSourceBytes} bytes); capture paused`);
    }
    for (const file of files) this.writeObject(file);
    const id = randomUUID();
    const checkout = db.prepare("SELECT id FROM checkpoints ORDER BY created_at, rowid LIMIT 1").get() as
      | { id: string } | undefined;
    const checkpoint: Checkpoint = {
      id, kind, createdAt: new Date().toISOString(), digest,
      files: files.map(({ path, digest: blobDigest, size }) => ({ path, digest: blobDigest, size })),
      checkoutId: checkout?.id ?? id,
      appId: this.configuredAppId(),
      uncapturedInputClasses: [...UNCAPTURED_INPUT_CLASSES],
      ...(turnKey ? { turnKey } : {}),
      ...(metadata?.overlap ? { overlap: true } : {}),
    };
    const manifest: Manifest = { schemaVersion: 1, includePolicyVersion: 1, ...checkpoint };
    const manifestPath = join(this.storage, "manifests", `${checkpoint.id}.json`);
    atomicWrite(manifestPath, JSON.stringify(manifest));
    this.verifyManifest(manifest);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO checkpoints (id, kind, created_at, digest, turn_key, manifest_path) VALUES (?, ?, ?, ?, ?, ?)")
        .run(checkpoint.id, kind, checkpoint.createdAt, digest, turnKey ?? null, `manifests/${checkpoint.id}.json`);
      const insertFile = db.prepare("INSERT INTO checkpoint_files (checkpoint_id, path, digest, size) VALUES (?, ?, ?, ?)");
      for (const file of checkpoint.files) insertFile.run(checkpoint.id, file.path, file.digest, file.size);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return checkpoint;
  }

  list(): Checkpoint[] {
    const rows = this.database().prepare("SELECT id FROM checkpoints ORDER BY created_at, rowid").all() as { id: string }[];
    return rows.map(({ id }) => this.getManifest(id));
  }

  readFile(id: string, relativePath: string): Buffer {
    if (!CHECKPOINT_ID.test(id) || !this.validRelativePath(relativePath)) throw new Error("Invalid checkpoint path");
    const indexed = this.database().prepare("SELECT digest, size FROM checkpoint_files WHERE checkpoint_id = ? AND path = ?")
      .get(id, relativePath) as { digest: string; size: number } | undefined;
    if (!indexed) throw new Error("File not present in checkpoint");
    const manifest = this.getManifest(id);
    const file = manifest.files.find((entry) => entry.path === relativePath);
    if (!file || file.digest !== indexed.digest || file.size !== indexed.size) throw new Error("Checkpoint path index corrupt");
    return this.readObject(file);
  }

  listPathHistory(relativePath: string): string[] {
    if (!this.validRelativePath(relativePath)) throw new Error("Invalid checkpoint path");
    return (this.database().prepare(`
      SELECT checkpoint_id FROM checkpoint_files
      JOIN checkpoints ON checkpoints.id = checkpoint_files.checkpoint_id
      WHERE path = ? ORDER BY checkpoints.created_at, checkpoints.rowid
    `).all(relativePath) as { checkpoint_id: string }[]).map((row) => row.checkpoint_id);
  }

  rebaseManifestPaths(previousRoot: string): number {
    const db = this.database();
    const rows = db.prepare("SELECT id, manifest_path FROM checkpoints").all() as
      { id: string; manifest_path: string }[];
    const updates: { id: string; path: string }[] = [];
    for (const row of rows) {
      const previous = join(previousRoot, ".rewindry", "manifests", `${row.id}.json`);
      const current = join(this.storage, "manifests", `${row.id}.json`);
      const relativePath = `manifests/${row.id}.json`;
      if (row.manifest_path !== previous && row.manifest_path !== current && row.manifest_path !== relativePath) {
        throw new Error("Checkpoint manifest path cannot be rebased");
      }
      this.verifyManifest(this.readManifestAt(current, row.id));
      if (row.manifest_path !== relativePath) updates.push({ id: row.id, path: relativePath });
    }
    if (!updates.length) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare("UPDATE checkpoints SET manifest_path = ? WHERE id = ?");
      for (const row of updates) update.run(row.path, row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return updates.length;
  }

  currentDigest(): string {
    this.database();
    return this.treeDigest(this.scan());
  }

  sourceStorageBytes(): number {
    this.database();
    const objects = join(this.storage, "objects");
    let bytes = 0;
    for (const prefix of readdirSync(objects, { withFileTypes: true })) {
      if (prefix.isSymbolicLink()) throw new Error("Object directory is a symlink");
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      const directory = join(objects, prefix.name);
      if (lstatSync(directory).isSymbolicLink()) throw new Error("Object directory is a symlink");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!HEX_SHA256.test(entry.name)) continue;
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error("Invalid source object");
        bytes += stat.size;
      }
    }
    return bytes;
  }

  sourceBudgetBytes(): number {
    return this.maxSourceBytes;
  }

  upsertUiState(input: UiStateInput, options?: { maxStates?: number }): UiState {
    const db = this.database();
    if (!["learned", "configured"].includes(input.origin)) throw new Error("Invalid UI state origin");
    if (typeof input.route !== "string" || !input.route.startsWith("/") || input.route.length > 2_048) {
      throw new Error("Invalid UI state route");
    }
    if (!HEX_SHA256.test(input.componentSet)) throw new Error("Invalid UI state component set");
    const pathJson = JSON.stringify(input.path);
    if (!Array.isArray(input.path) || Buffer.byteLength(pathJson) > MAX_STATE_PATH_BYTES) throw new Error("Invalid UI state path");
    const modules = input.modules ?? [];
    if (!Array.isArray(modules) || modules.length > MAX_STATE_MODULES ||
        !modules.every((module) => typeof module === "string" && this.validRelativePath(module))) {
      throw new Error("Invalid UI state modules");
    }
    const components = input.components ?? [];
    if (!Array.isArray(components) || components.length > MAX_STATE_MODULES ||
        !components.every((key) => typeof key === "string" && key.length > 0 && key.length <= 512)) {
      throw new Error("Invalid UI state components");
    }
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT id, path_json, status FROM ui_states WHERE route = ? AND component_set = ?")
        .get(input.route, input.componentSet) as { id: string; path_json: string; status: string } | undefined;
      if (existing) {
        // Keep the shortest working path; any working path repairs a broken one.
        const replacePath = existing.status === "path_broken" ||
          input.path.length < (JSON.parse(existing.path_json) as unknown[]).length;
        db.prepare(`UPDATE ui_states SET path_json = ?, components_json = ?, modules_json = ?, status = 'active', last_seen_at = ? WHERE id = ?`)
          .run(replacePath ? pathJson : existing.path_json, JSON.stringify(components), JSON.stringify(modules), now, existing.id);
      } else {
        const maxStates = options?.maxStates;
        if (maxStates !== undefined) {
          const { count } = db.prepare("SELECT COUNT(*) AS count FROM ui_states").get() as { count: number };
          if (count >= maxStates) {
            // Evict the least recently seen learned state that has no history; never delete captured history.
            const victim = db.prepare(`SELECT id FROM ui_states WHERE origin = 'learned'
              AND NOT EXISTS (SELECT 1 FROM screen_frames WHERE screen_frames.state_id = ui_states.id)
              ORDER BY last_seen_at, id LIMIT 1`).get() as { id: string } | undefined;
            if (!victim) throw new Error("UI state limit reached");
            db.prepare("DELETE FROM ui_states WHERE id = ?").run(victim.id);
          }
        }
        db.prepare(`INSERT INTO ui_states (id, origin, route, path_json, component_set, components_json, modules_json, status, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(randomUUID(), input.origin, input.route, pathJson, input.componentSet, JSON.stringify(components), JSON.stringify(modules), now, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.listUiStates().find((state) => state.route === input.route && state.componentSet === input.componentSet)!;
  }

  listUiStates(): UiState[] {
    const rows = this.database().prepare("SELECT * FROM ui_states ORDER BY last_seen_at DESC, id").all() as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id!, origin: row.origin as UiStateOrigin, route: row.route!,
      path: JSON.parse(row.path_json!) as unknown[], componentSet: row.component_set!,
      components: JSON.parse(row.components_json!) as string[],
      modules: JSON.parse(row.modules_json!) as string[], status: row.status as UiState["status"],
      firstSeenAt: row.first_seen_at!, lastSeenAt: row.last_seen_at!,
    }));
  }

  markUiStatePathBroken(id: string): void {
    this.setUiStateStatus(id, "path_broken");
  }

  setUiStateStatus(id: string, status: UiState["status"]): void {
    if (status !== "active" && status !== "path_broken") throw new Error("Invalid UI state status");
    const result = this.database().prepare("UPDATE ui_states SET status = ? WHERE id = ?").run(status, id);
    if (!result.changes) throw new Error("UI state not found");
  }

  // What a replay actually rendered; identity (route + component set) is unchanged.
  updateUiStateComponents(id: string, components: string[]): void {
    if (!Array.isArray(components) || components.length > MAX_STATE_MODULES ||
        !components.every((key) => typeof key === "string" && key.length > 0 && key.length <= 512)) {
      throw new Error("Invalid UI state components");
    }
    const result = this.database().prepare("UPDATE ui_states SET components_json = ? WHERE id = ?").run(JSON.stringify(components), id);
    if (!result.changes) throw new Error("UI state not found");
  }

  // When each state last produced an image (new or unchanged), for fair selection under the frame budget.
  lastRenderedTimes(): Map<string, string> {
    const rows = this.database().prepare("SELECT state_id, max(captured_at) AS at FROM screen_frames WHERE status IN ('captured', 'unchanged') GROUP BY state_id")
      .all() as { state_id: string; at: string }[];
    return new Map(rows.map((row) => [row.state_id, row.at]));
  }

  // Learned screens retired from capture: still marked broken, and their path failed at every breakpoint in each of the
  // last `attempts` live updates that tried them. Visiting the screen again relearns its path and makes it active.
  retiredStateIds(attempts = 3): Set<string> {
    const rows = this.database().prepare(`
      SELECT ui_states.id AS stateId, MAX(screen_frames.status IN ('captured', 'unchanged')) AS rendered
      FROM ui_states
        JOIN screen_frames ON screen_frames.state_id = ui_states.id
        JOIN checkpoints ON checkpoints.id = screen_frames.checkpoint_id
      WHERE ui_states.status = 'path_broken' AND screen_frames.capture_mode = 'live'
        AND screen_frames.status IN ('captured', 'unchanged', 'path_broken')
      GROUP BY ui_states.id, checkpoints.rowid
      ORDER BY ui_states.id, checkpoints.rowid DESC`).all() as { stateId: string; rendered: number }[];
    const recent = new Map<string, number[]>();
    for (const row of rows) {
      const list = recent.get(row.stateId) ?? [];
      if (list.length < attempts) list.push(row.rendered);
      recent.set(row.stateId, list);
    }
    return new Set([...recent].filter(([, list]) => list.length === attempts && list.every((rendered) => !rendered)).map(([id]) => id));
  }

  // A frame with an image (captured or unchanged) is final; unreachable, failed and skipped frames are retried by a later run.
  hasRenderedScreenFrame(checkpointId: string, stateId: string, profileId: string): boolean {
    return !!this.database().prepare(`SELECT 1 FROM screen_frames WHERE checkpoint_id = ? AND state_id = ? AND profile_id = ?
      AND status IN ('captured', 'unchanged')`).get(checkpointId, stateId, profileId);
  }

  // The latest frame with an image from a checkpoint before the given one, for deduplication.
  previousFrameImage(checkpointId: string, stateId: string, profileId: string): { checkpointId: string; imageDigest: string; unchangedFrom?: string } | undefined {
    const row = this.database().prepare(`
      SELECT screen_frames.checkpoint_id, image_digest, unchanged_from FROM screen_frames
      JOIN checkpoints ON checkpoints.id = screen_frames.checkpoint_id
      WHERE state_id = ? AND profile_id = ? AND image_digest IS NOT NULL
        AND checkpoints.rowid < (SELECT rowid FROM checkpoints WHERE id = ?)
      ORDER BY checkpoints.rowid DESC LIMIT 1
    `).get(stateId, profileId, checkpointId) as { checkpoint_id: string; image_digest: string; unchanged_from: string | null } | undefined;
    return row ? { checkpointId: row.checkpoint_id, imageDigest: row.image_digest, ...(row.unchanged_from ? { unchangedFrom: row.unchanged_from } : {}) } : undefined;
  }

  // The latest version of each component instance in a state/profile before the given checkpoint.
  previousComponentCrops(checkpointId: string, stateId: string, profileId: string): Map<string, { checkpointId: string; cropDigest: string; unchangedFrom?: string }> {
    const rows = this.database().prepare(`
      SELECT component_versions.checkpoint_id, component_key, occurrence, crop_digest, unchanged_from FROM component_versions
      JOIN checkpoints ON checkpoints.id = component_versions.checkpoint_id
      WHERE state_id = ? AND profile_id = ? AND checkpoints.rowid < (SELECT rowid FROM checkpoints WHERE id = ?)
      ORDER BY checkpoints.rowid
    `).all(stateId, profileId, checkpointId) as { checkpoint_id: string; component_key: string; occurrence: number; crop_digest: string; unchanged_from: string | null }[];
    const latest = new Map<string, { checkpointId: string; cropDigest: string; unchangedFrom?: string }>();
    for (const row of rows) {
      latest.set(`${row.component_key}@${row.occurrence}`, {
        checkpointId: row.checkpoint_id, cropDigest: row.crop_digest, ...(row.unchanged_from ? { unchangedFrom: row.unchanged_from } : {}),
      });
    }
    return latest;
  }

  // Aggregates for the history browser: what has history, and how many real (changed) versions.
  historySummary(): {
    states: { stateId: string; frames: number; changed: number }[];
    components: { componentKey: string; versions: number; changed: number; states: number; lastChangedRow: number }[];
    profiles: string[];
  } {
    const db = this.database();
    // `changed` counts iterations with a real change, not rows: breakpoints, screens and repeated copies of a
    // component would otherwise each add to it.
    const states = db.prepare(`SELECT state_id AS stateId, COUNT(*) AS frames,
        COUNT(DISTINCT CASE WHEN status = 'captured' THEN checkpoint_id END) AS changed
      FROM screen_frames GROUP BY state_id`).all() as { stateId: string; frames: number; changed: number }[];
    const components = db.prepare(`
      SELECT component_key AS componentKey, COUNT(*) AS versions,
        COUNT(DISTINCT CASE WHEN unchanged_from IS NULL THEN checkpoint_id END) AS changed,
        COUNT(DISTINCT state_id) AS states, MAX(CASE WHEN unchanged_from IS NULL THEN checkpoints.rowid END) AS lastChangedRow
      FROM component_versions JOIN checkpoints ON checkpoints.id = component_versions.checkpoint_id
      GROUP BY component_key ORDER BY lastChangedRow DESC, component_key
    `).all() as { componentKey: string; versions: number; changed: number; states: number; lastChangedRow: number }[];
    const profiles = (db.prepare("SELECT DISTINCT profile_id FROM screen_frames ORDER BY profile_id").all() as { profile_id: string }[])
      .map((row) => row.profile_id);
    return { states, components, profiles };
  }

  // Only images that a recorded frame or component version points at are ever served.
  visualReferenced(digest: string): boolean {
    if (!HEX_SHA256.test(digest)) return false;
    const db = this.database();
    return !!db.prepare("SELECT 1 FROM screen_frames WHERE image_digest = ? LIMIT 1").get(digest) ||
      !!db.prepare("SELECT 1 FROM component_versions WHERE crop_digest = ? LIMIT 1").get(digest);
  }

  visualStorageBytes(): number {
    const directory = join(this.storage, "visuals");
    if (!existsSync(directory)) return 0;
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Visual directory is a symlink");
    let bytes = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9]{64}\.png$/.test(entry.name)) bytes += lstatSync(join(directory, entry.name)).size;
    }
    return bytes;
  }

  recordScreenFrame(input: ScreenFrameInput): void {
    const db = this.database();
    if (!CHECKPOINT_ID.test(input.checkpointId) || !PROFILE_ID.test(input.profileId) ||
        !FRAME_STATUSES.includes(input.status) || !["live", "replayed"].includes(input.captureMode) ||
        (input.imageDigest !== undefined && !HEX_SHA256.test(input.imageDigest)) ||
        (input.unchangedFrom !== undefined && !CHECKPOINT_ID.test(input.unchangedFrom))) {
      throw new Error("Invalid screen frame");
    }
    const components = input.components ?? [];
    if (components.length && !["captured", "unchanged"].includes(input.status)) throw new Error("Components need a captured frame");
    for (const component of components) {
      const box = component.box;
      if (typeof component.componentKey !== "string" || !component.componentKey || component.componentKey.length > 512 ||
          !Number.isSafeInteger(component.occurrence) || component.occurrence < 0 || !HEX_SHA256.test(component.cropDigest) ||
          (component.unchangedFrom !== undefined && !CHECKPOINT_ID.test(component.unchangedFrom)) ||
          ![box?.x, box?.y, box?.width, box?.height].every((value) => Number.isFinite(value)) || box.width <= 0 || box.height <= 0) {
        throw new Error("Invalid component version");
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      // A retry replaces an earlier frame without an image; a rendered frame is never replaced.
      db.prepare(`DELETE FROM screen_frames WHERE checkpoint_id = ? AND state_id = ? AND profile_id = ?
        AND status NOT IN ('captured', 'unchanged')`).run(input.checkpointId, input.stateId, input.profileId);
      db.prepare(`INSERT INTO screen_frames (checkpoint_id, state_id, profile_id, status, image_digest, unchanged_from, capture_mode, reason, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.checkpointId, input.stateId, input.profileId, input.status,
        input.imageDigest ?? null, input.unchangedFrom ?? null, input.captureMode, input.reason?.slice(0, 512) ?? null,
        new Date().toISOString());
      const insert = db.prepare(`INSERT INTO component_versions
        (checkpoint_id, state_id, profile_id, component_key, occurrence, crop_digest, unchanged_from, box_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const component of components) {
        const { x, y, width, height } = component.box;
        insert.run(input.checkpointId, input.stateId, input.profileId, component.componentKey, component.occurrence,
          component.cropDigest, component.unchangedFrom ?? null, JSON.stringify({ x, y, width, height }));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listScreenFrames(stateId: string, profileId?: string): ScreenFrame[] {
    const rows = this.database().prepare(`
      SELECT screen_frames.* FROM screen_frames JOIN checkpoints ON checkpoints.id = screen_frames.checkpoint_id
      WHERE state_id = ? AND (? IS NULL OR profile_id = ?) ORDER BY checkpoints.created_at, checkpoints.rowid, profile_id
    `).all(stateId, profileId ?? null, profileId ?? null) as Record<string, string | null>[];
    return rows.map((row) => ({
      checkpointId: row.checkpoint_id!, stateId: row.state_id!, profileId: row.profile_id!, status: row.status as FrameStatus,
      captureMode: row.capture_mode as ScreenFrame["captureMode"], capturedAt: row.captured_at!,
      ...(row.image_digest ? { imageDigest: row.image_digest } : {}),
      ...(row.unchanged_from ? { unchangedFrom: row.unchanged_from } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    }));
  }

  listComponentVersions(componentKey: string, profileId?: string): ComponentVersion[] {
    const rows = this.database().prepare(`
      SELECT component_versions.*, screen_frames.capture_mode FROM component_versions
      JOIN checkpoints ON checkpoints.id = component_versions.checkpoint_id
      JOIN screen_frames USING (checkpoint_id, state_id, profile_id)
      WHERE component_key = ? AND (? IS NULL OR component_versions.profile_id = ?)
      ORDER BY checkpoints.created_at, checkpoints.rowid, component_versions.state_id, component_versions.profile_id, occurrence
    `).all(componentKey, profileId ?? null, profileId ?? null) as Record<string, string | number | null>[];
    return rows.map((row) => ({
      checkpointId: row.checkpoint_id as string, stateId: row.state_id as string, profileId: row.profile_id as string,
      componentKey: row.component_key as string, occurrence: row.occurrence as number, cropDigest: row.crop_digest as string,
      box: JSON.parse(row.box_json as string) as VisualBox, captureMode: row.capture_mode as ComponentVersion["captureMode"],
      ...(row.unchanged_from ? { unchangedFrom: row.unchanged_from as string } : {}),
    }));
  }

  writeVisual(bytes: Buffer): string {
    const digest = sha256(bytes);
    const path = this.visualPath(digest);
    if (!existsSync(path)) atomicWrite(path, bytes);
    this.readVisual(digest);
    return digest;
  }

  readVisual(digest: string): Buffer {
    const path = this.visualPath(digest);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error("Visual unavailable");
    const bytes = readFileSync(path);
    if (sha256(bytes) !== digest) throw new Error("Visual corrupt");
    return bytes;
  }

  private visualPath(digest: string): string {
    this.database();
    if (!HEX_SHA256.test(digest)) throw new Error("Invalid visual digest");
    const directory = join(this.storage, "visuals");
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("Visual directory is a symlink");
    return join(directory, `${digest}.png`);
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error("Store is not initialized");
    return this.db;
  }

  private readPatterns(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every((item) =>
      typeof item === "string" && item.length > 0 && !item.startsWith("/") && !item.includes("..") && !item.includes("\\"))) {
      throw new Error("Invalid capture patterns");
    }
    return value;
  }

  private validRelativePath(path: string): boolean {
    return !!path && !isAbsolute(path) && !path.includes("\\") &&
      path.split("/").every((part) => part && part !== "." && part !== "..");
  }

  private eligible(path: string): boolean {
    if (isPrivatePath(path)) return false;
    if (this.exclude.some((pattern) => matchesGlob(path, pattern))) return false;
    return this.include.some((pattern) => matchesGlob(path, pattern));
  }

  private scan(): CapturedFile[] {
    const files: CapturedFile[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const path = relative(this.root, absolute).split(sep).join("/");
        if (entry.isSymbolicLink()) continue;
        if (!isInside(this.root, absolute) || isPrivatePath(path)) continue;
        if (entry.isDirectory()) {
          if ([".rewindry", ".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
          if (!lstatSync(absolute).isDirectory() || !isInside(this.root, realpathSync(absolute))) continue;
          visit(absolute);
        } else if (entry.isFile() && this.eligible(path)) {
          const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) continue;
            if (stat.size > this.maxFileBytes) {
              throw new Error(`Eligible source exceeds maxFileBytes (${this.maxFileBytes}): ${path}`);
            }
            bytes = readFileSync(fd);
          } finally { closeSync(fd); }
          if (bytes.length > this.maxFileBytes) {
            throw new Error(`Eligible source exceeds maxFileBytes (${this.maxFileBytes}): ${path}`);
          }
          files.push({ path, digest: sha256(bytes), size: bytes.length, bytes });
        }
      }
    };
    visit(this.root);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return files;
  }

  private treeDigest(files: CheckpointFile[]): string {
    return sha256(JSON.stringify(files.map(({ path, digest, size }) => [path, digest, size])));
  }

  private objectPath(digest: string): string {
    if (!HEX_SHA256.test(digest)) throw new Error("Invalid object digest");
    return join(this.storage, "objects", digest.slice(0, 2), digest);
  }

  private writeObject(file: CapturedFile): void {
    const path = this.objectPath(file.digest);
    if (existsSync(path)) {
      this.readObject(file);
      return;
    }
    const parent = dirname(path);
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("Object directory is a symlink");
    atomicWrite(path, file.bytes);
    this.readObject(file);
  }

  private readObject(file: CheckpointFile): Buffer {
    const path = this.objectPath(file.digest);
    if (!lstatSync(path).isFile()) throw new Error("Object unavailable");
    const bytes = readFileSync(path);
    if (bytes.length !== file.size || sha256(bytes) !== file.digest) throw new Error("Object corrupt");
    return bytes;
  }

  private getManifest(id: string): Manifest {
    if (!CHECKPOINT_ID.test(id)) throw new Error("Invalid checkpoint ID");
    const row = this.database().prepare("SELECT manifest_path FROM checkpoints WHERE id = ?").get(id) as
      | { manifest_path: string } | undefined;
    if (!row) throw new Error("Checkpoint not found");
    if (!this.manifestPathMatches(row.manifest_path, id)) throw new Error("Manifest unavailable");
    return this.readManifestAt(join(this.storage, "manifests", `${id}.json`), id);
  }

  // The manifest is always read from this store's own manifests folder. The recorded path is relative
  // (`manifests/<id>.json`); older checkpoints recorded an absolute path, accepted wherever the project
  // now lives so a copied or moved store keeps working.
  private manifestPathMatches(recorded: string, id: string): boolean {
    if (recorded === `manifests/${id}.json`) return true;
    return isAbsolute(recorded) && recorded.endsWith(`${sep}.rewindry${sep}manifests${sep}${id}.json`);
  }

  private readManifestAt(path: string, id: string): Manifest {
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error("Manifest unavailable");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (manifest.id !== id || manifest.schemaVersion !== 1 || manifest.includePolicyVersion !== 1 ||
        (manifest.overlap !== undefined && (manifest.overlap !== true || manifest.kind !== "unattributed_group")) ||
        (manifest.checkoutId !== undefined && !CHECKPOINT_ID.test(manifest.checkoutId)) ||
        (manifest.appId !== undefined && manifest.appId !== null &&
          (typeof manifest.appId !== "string" || !manifest.appId)) ||
        (manifest.uncapturedInputClasses !== undefined &&
          (!Array.isArray(manifest.uncapturedInputClasses) ||
            !manifest.uncapturedInputClasses.every((value) => typeof value === "string" && !!value))) ||
        !Array.isArray(manifest.files) || !manifest.files.every((file) =>
          this.validRelativePath(file.path) && HEX_SHA256.test(file.digest) &&
          Number.isSafeInteger(file.size) && file.size >= 0) ||
        manifest.digest !== this.treeDigest(manifest.files)) {
      throw new Error("Manifest corrupt");
    }
    return manifest;
  }

  private verifyManifest(manifest: Manifest): void {
    for (const file of manifest.files) this.readObject(file);
  }

  private configuredAppId(): string | null {
    const path = join(this.storage, "config.json");
    if (!existsSync(path)) return null;
    const config = JSON.parse(readFileSync(path, "utf8")) as { preview?: { appId?: unknown } };
    return typeof config.preview?.appId === "string" && config.preview.appId
      ? config.preview.appId : null;
  }
}
