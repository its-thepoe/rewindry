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

type Manifest = Checkpoint & { schemaVersion: 1; includePolicyVersion: 1 };
type CapturedFile = CheckpointFile & { bytes: Buffer };

const DEFAULT_INCLUDE = [
  "src/**", "public/**", "app/**", "pages/**", "components/**", "styles/**",
  "assets/**", "lib/**", "client/**", "index.html", "package.json", "*lock*",
  "vite.config.*", "postcss.config.*", "tailwind.config.*", "tsconfig*.json",
  "jsconfig*.json", "*.config.css", "*.css",
];
const DEFAULT_EXCLUDE = [".rewindry/**", ".git/**", "node_modules/**", "dist/**", "build/**", "coverage/**"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;
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
      };
      const capture = config.capture;
      if (capture?.include !== undefined) this.include = this.readPatterns(capture.include);
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
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 2) {
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
        .run(checkpoint.id, kind, checkpoint.createdAt, digest, turnKey ?? null, manifestPath);
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
      if (row.manifest_path !== previous && row.manifest_path !== current) {
        throw new Error("Checkpoint manifest path cannot be rebased");
      }
      this.verifyManifest(this.readManifestAt(current, row.id));
      if (row.manifest_path !== current) updates.push({ id: row.id, path: current });
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
    const expected = join(this.storage, "manifests", `${id}.json`);
    if (row.manifest_path !== expected) throw new Error("Manifest unavailable");
    return this.readManifestAt(expected, id);
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
