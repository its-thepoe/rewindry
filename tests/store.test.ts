import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WorkspaceStore } from "../src/store.js";

function fixture(): { root: string; store: WorkspaceStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rewindry-store-"));
  const store = new WorkspaceStore(root);
  store.initialize();
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("creates immutable full-tree checkpoints and deduplicates blobs", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "first");
    writeFileSync(join(root, "index.html"), "<main>one</main>");
    const baseline = store.snapshot("baseline");
    assert.ok(baseline);
    assert.equal(baseline.checkoutId, baseline.id);
    assert.equal(baseline.appId, null);
    assert.ok(baseline.uncapturedInputClasses?.includes("browser and process state"));
    assert.deepEqual(baseline.files.map((file) => file.path), ["index.html", "src/app.ts"]);
    assert.equal(store.readFile(baseline.id, "src/app.ts").toString(), "first");
    assert.equal(store.snapshot("agent_turn", "turn-unchanged"), null);
    writeFileSync(join(root, "src", "app.ts"), "second");
    writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ preview: { appId: "fixture-app" } }));
    const next = store.snapshot("agent_turn", "turn-1");
    assert.ok(next);
    assert.equal(next.checkoutId, baseline.id);
    assert.equal(next.appId, "fixture-app");
    assert.notEqual(next.digest, baseline.digest);
    assert.equal(store.readFile(baseline.id, "src/app.ts").toString(), "first");
    assert.equal(store.readFile(next.id, "src/app.ts").toString(), "second");
    assert.equal(store.snapshot("agent_turn", "turn-1"), null);
    const digest = createHash("sha256").update("<main>one</main>").digest("hex");
    assert.deepEqual(readdirSync(join(root, ".rewindry", "objects", digest.slice(0, 2))), [digest]);
    const restarted = new WorkspaceStore(root);
    restarted.initialize();
    assert.deepEqual(restarted.list().map((item) => item.id), [baseline.id, next.id]);
    assert.equal(restarted.list()[1]?.checkoutId, baseline.id);
    assert.equal(restarted.readFile(baseline.id, "src/app.ts").toString(), "first");
  } finally { cleanup(); }
});

test("linked worktrees keep separate checkout histories and preview app identities", () => {
  const temp = mkdtempSync(join(tmpdir(), "rewindry-worktrees-"));
  const primary = join(temp, "primary");
  const linked = join(temp, "linked");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    mkdirSync(join(primary, "src"), { recursive: true });
    writeFileSync(join(primary, "src", "app.ts"), "shared baseline");
    git("-C", primary, "init", "-b", "main");
    git("-C", primary, "add", "src/app.ts");
    git("-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
    git("-C", primary, "worktree", "add", "-b", "linked", linked);
    const first = new WorkspaceStore(primary);
    const second = new WorkspaceStore(linked);
    first.initialize();
    second.initialize();
    writeFileSync(join(primary, ".rewindry", "config.json"), JSON.stringify({ preview: { appId: "app-primary" } }));
    writeFileSync(join(linked, ".rewindry", "config.json"), JSON.stringify({ preview: { appId: "app-linked" } }));
    const firstBaseline = first.snapshot("baseline");
    const secondBaseline = second.snapshot("baseline");
    assert.ok(firstBaseline && secondBaseline);
    assert.notEqual(firstBaseline.checkoutId, secondBaseline.checkoutId);
    assert.equal(firstBaseline.appId, "app-primary");
    assert.equal(secondBaseline.appId, "app-linked");
    writeFileSync(join(linked, "src", "app.ts"), "linked change");
    const linkedChange = second.snapshot("unattributed_group");
    assert.ok(linkedChange);
    assert.equal(linkedChange.checkoutId, secondBaseline.id);
    assert.equal(first.list().length, 1);
    assert.equal(first.readFile(firstBaseline.id, "src/app.ts").toString(), "shared baseline");
    assert.equal(second.readFile(linkedChange.id, "src/app.ts").toString(), "linked change");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("source policy covers build inputs while excluding generated and private data", () => {
  const { root, store, cleanup } = fixture();
  try {
    for (const directory of ["src", "public", "dist", "node_modules", "assets"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "src", "main.css"), "body {}");
    writeFileSync(join(root, "public", "logo.svg"), "<svg/>");
    writeFileSync(join(root, "assets", "icon.png"), "png");
    writeFileSync(join(root, "vite.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, ".env.local"), "TOKEN=private");
    writeFileSync(join(root, "src", "secret.ts"), "private");
    writeFileSync(join(root, "dist", "bundle.js"), "generated");
    writeFileSync(join(root, "node_modules", "pkg.js"), "dependency");
    const checkpoint = store.snapshot("baseline");
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.files.map((file) => file.path), [
      "assets/icon.png", "package.json", "public/logo.svg", "src/main.css", "vite.config.ts",
    ]);
    const digest = store.currentDigest();
    writeFileSync(join(root, ".env.local"), "TOKEN=changed");
    assert.equal(store.currentDigest(), digest);
    writeFileSync(join(root, "vite.config.ts"), "export default { plugins: [] }");
    assert.notEqual(store.currentDigest(), digest);
  } finally { cleanup(); }
});

test("a Vite config named in preview.viteConfig is saved with checkpoints; unsafe names are refused", () => {
  const { root, store, cleanup } = fixture();
  try {
    writeFileSync(join(root, "vite.demo-site.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), "{}");
    assert.deepEqual(store.snapshot("baseline")!.files.map((file) => file.path), ["package.json"]);
    writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ preview: { viteConfig: "vite.demo-site.config.ts" } }));
    const named = new WorkspaceStore(root);
    named.initialize();
    writeFileSync(join(root, "package.json"), "{\"name\":\"demo\"}");
    assert.deepEqual(named.snapshot("unattributed_group")!.files.map((file) => file.path), ["package.json", "vite.demo-site.config.ts"]);
    for (const viteConfig of ["../vite.config.ts", "/etc/vite.config.ts", "./vite.config.ts", "vite.config.json", "a/../b.ts", 7]) {
      writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ preview: { viteConfig } }));
      assert.throws(() => new WorkspaceStore(root).initialize(), /Invalid preview\.viteConfig/, String(viteConfig));
    }
    writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ preview: { viteConfigLoader: "eval" } }));
    assert.throws(() => new WorkspaceStore(root).initialize(), /Invalid preview\.viteConfigLoader/);
  } finally { cleanup(); }
});

test("rejects traversal and ignores symlinks escaping the workspace", () => {
  const { root, store, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "rewindry-outside-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "safe.ts"), "safe");
    writeFileSync(join(outside, "private.ts"), "private");
    symlinkSync(join(outside, "private.ts"), join(root, "src", "external.ts"));
    symlinkSync(outside, join(root, "src", "external-dir"));
    const checkpoint = store.snapshot("baseline");
    assert.ok(checkpoint);
    assert.deepEqual(checkpoint.files.map((file) => file.path), ["src/safe.ts"]);
    assert.throws(() => store.readFile(checkpoint.id, "../src/safe.ts"));
    assert.throws(() => store.readFile(checkpoint.id, "/etc/passwd"));
    assert.throws(() => store.readFile(checkpoint.id, "src/external.ts"));
  } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("deletions change the tree and historical bytes remain readable", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "old.ts"), "old");
    const first = store.snapshot("baseline");
    assert.ok(first);
    rmSync(join(root, "src", "old.ts"));
    const second = store.snapshot("unattributed_group");
    assert.ok(second);
    assert.deepEqual(second.files, []);
    assert.equal(store.readFile(first.id, "src/old.ts").toString(), "old");
    assert.throws(() => store.readFile(second.id, "src/old.ts"));
  } finally { cleanup(); }
});

test("a corrupt object never falls back to current workspace content", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "original");
    const checkpoint = store.snapshot("baseline");
    assert.ok(checkpoint);
    const digest = checkpoint.files[0]!.digest;
    writeFileSync(join(root, ".rewindry", "objects", digest.slice(0, 2), digest), "corrupt");
    writeFileSync(join(root, "src", "app.ts"), "current");
    assert.throws(() => store.readFile(checkpoint.id, "src/app.ts"), /corrupt/);
  } finally { cleanup(); }
});

test("oversized eligible source is reported and never silently omitted", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ capture: { maxFileBytes: 8 } }));
    store.initialize();
    writeFileSync(join(root, "src", "app.ts"), "small");
    const first = store.snapshot("baseline");
    assert.ok(first);
    writeFileSync(join(root, "src", "large.ts"), "more than eight bytes");
    assert.throws(() => store.snapshot("agent_turn", "oversize"), /Eligible source exceeds maxFileBytes.*src\/large\.ts/);
    assert.throws(() => store.currentDigest(), /Eligible source exceeds maxFileBytes/);
    assert.equal(store.list().length, 1);
    assert.equal(store.readFile(first.id, "src/app.ts").toString(), "small");
  } finally { cleanup(); }
});

test("failed publication leaves only complete checkpoints visible and recovers after restart", () => {
  const { root, store, cleanup } = fixture();
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "before");
    const baseline = store.snapshot("baseline");
    assert.ok(baseline);
    writeFileSync(join(root, "src", "app.ts"), "after");

    db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
    db.exec("CREATE TRIGGER fail_checkpoint_publish BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;");
    assert.throws(() => store.snapshot("agent_turn", "interrupted"), /injected publication failure/);
    assert.deepEqual(store.list().map((item) => item.id), [baseline.id]);
    assert.equal(store.readFile(baseline.id, "src/app.ts").toString(), "before");

    db.exec("DROP TRIGGER fail_checkpoint_publish;");
    db.close();
    db = undefined;
    const restarted = new WorkspaceStore(root);
    restarted.initialize();
    assert.deepEqual(restarted.list().map((item) => item.id), [baseline.id]);
    const recovered = restarted.snapshot("agent_turn", "interrupted");
    assert.ok(recovered);
    assert.equal(restarted.readFile(recovered.id, "src/app.ts").toString(), "after");
  } finally {
    db?.close();
    cleanup();
  }
});

test("source budget pauses new checkpoints without deleting older history", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".rewindry", "config.json"), JSON.stringify({ capture: { maxSourceBytes: 10 } }));
    store.initialize();
    writeFileSync(join(root, "src", "app.ts"), "before");
    const baseline = store.snapshot("baseline");
    assert.ok(baseline);
    assert.equal(store.sourceStorageBytes(), 6);
    assert.equal(store.sourceBudgetBytes(), 10);
    writeFileSync(join(root, "src", "app.ts"), "after!");
    assert.throws(() => store.snapshot("agent_turn", "over-budget"), /Source storage budget exceeded.*capture paused/);
    assert.deepEqual(store.list().map((item) => item.id), [baseline.id]);
    assert.equal(store.sourceStorageBytes(), 6);
    assert.equal(store.readFile(baseline.id, "src/app.ts").toString(), "before");

    writeFileSync(join(root, "src", "app.ts"), "before");
    assert.equal(store.snapshot("agent_turn", "unchanged"), null);
  } finally { cleanup(); }
});

test("version 2 migration backfills the path index from existing manifests", () => {
  const { root, store, cleanup } = fixture();
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const first = store.snapshot("baseline");
    assert.ok(first);
    writeFileSync(join(root, "src", "app.ts"), "two");
    writeFileSync(join(root, "src", "other.ts"), "new");
    const second = store.snapshot("agent_turn", "turn-1");
    assert.ok(second);

    db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
    // A real version 1 store predates both the path index and the version 3 UI history tables.
    db.exec("DROP TABLE checkpoint_files; DROP TABLE component_versions; DROP TABLE screen_frames; DROP TABLE ui_states; PRAGMA user_version = 1;");
    db.close();
    db = undefined;
    const migrated = new WorkspaceStore(root);
    migrated.initialize();
    assert.deepEqual(migrated.listPathHistory("src/app.ts"), [first.id, second.id]);
    assert.deepEqual(migrated.listPathHistory("src/other.ts"), [second.id]);
    assert.equal(migrated.readFile(first.id, "src/app.ts").toString(), "one");
    assert.equal(migrated.readFile(second.id, "src/app.ts").toString(), "two");
    assert.throws(() => migrated.listPathHistory("../outside"), /Invalid checkpoint path/);
    migrated.initialize();
    assert.deepEqual(migrated.listPathHistory("src/app.ts"), [first.id, second.id]);
    assert.deepEqual(schemaOf(root), { version: 3, tables: UI_TABLES });
  } finally {
    db?.close();
    cleanup();
  }
});

test("overlap provenance survives restart on a grouped checkpoint", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    store.snapshot("baseline");
    writeFileSync(join(root, "src", "app.ts"), "mixed");
    const checkpoint = store.snapshot("unattributed_group", undefined, { overlap: true });
    assert.ok(checkpoint);
    assert.equal(checkpoint.overlap, true);
    const restarted = new WorkspaceStore(root);
    restarted.initialize();
    assert.equal(restarted.list().at(-1)?.overlap, true);
    assert.equal(restarted.readFile(checkpoint.id, "src/app.ts").toString(), "mixed");
    assert.throws(() => store.snapshot("agent_turn", "invalid", { overlap: true }), /Overlap requires/);
  } finally { cleanup(); }
});

test("process death after writing objects but before publication keeps history complete", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "before");
    const baseline = store.snapshot("baseline");
    assert.ok(baseline);
    writeFileSync(join(root, "src", "app.ts"), "after");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      import { WorkspaceStore } from './src/store.ts';
      const store = new WorkspaceStore(process.argv[1]);
      store.initialize();
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === 'BEGIN IMMEDIATE') process.kill(process.pid, 'SIGKILL');
        return exec.call(this, sql);
      };
      store.snapshot('agent_turn', 'after-kill');
    `, root], { cwd: resolve('.'), encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const restarted = new WorkspaceStore(root);
    restarted.initialize();
    assert.deepEqual(restarted.list().map((item) => item.id), [baseline.id]);
    assert.equal(restarted.readFile(baseline.id, "src/app.ts").toString(), "before");
    const recovered = restarted.snapshot("agent_turn", "after-kill");
    assert.ok(recovered);
    assert.equal(restarted.readFile(recovered.id, "src/app.ts").toString(), "after");
  } finally { cleanup(); }
});

const UI_TABLES = ["component_versions", "screen_frames", "ui_states"];
const schemaOf = (root: string) => {
  const db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ui_states', 'screen_frames', 'component_versions') ORDER BY name")
      .all() as { name: string }[]).map((row) => row.name);
    return { version, tables };
  } finally { db.close(); }
};
const downgradeToV2 = (root: string, extraSql = "") => {
  const db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
  db.exec(`DROP TABLE component_versions; DROP TABLE screen_frames; DROP TABLE ui_states; ${extraSql} PRAGMA user_version = 2;`);
  db.close();
};
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

test("fresh stores start at schema version 3 with UI history tables", () => {
  const { root, cleanup } = fixture();
  try {
    assert.deepEqual(schemaOf(root), { version: 3, tables: UI_TABLES });
  } finally { cleanup(); }
});

test("version 3 migration upgrades a version 2 store without touching history and reruns as a no-op", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const first = store.snapshot("baseline");
    writeFileSync(join(root, "src", "app.ts"), "two");
    const second = store.snapshot("agent_turn", "turn-1");
    assert.ok(first && second);
    const before = store.list();
    downgradeToV2(root);
    assert.deepEqual(schemaOf(root), { version: 2, tables: [] });

    const migrated = new WorkspaceStore(root);
    migrated.initialize();
    assert.deepEqual(schemaOf(root), { version: 3, tables: UI_TABLES });
    assert.deepEqual(migrated.list(), before);
    assert.deepEqual(migrated.listPathHistory("src/app.ts"), [first.id, second.id]);
    assert.equal(migrated.readFile(first.id, "src/app.ts").toString(), "one");

    const state = migrated.upsertUiState({ origin: "learned", route: "/", path: [], componentSet: hex("home") });
    migrated.initialize();
    assert.deepEqual(schemaOf(root), { version: 3, tables: UI_TABLES });
    assert.deepEqual(migrated.listUiStates(), [state]);
  } finally { cleanup(); }
});

test("a failed version 3 migration rolls back to an intact version 2 store", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const baseline = store.snapshot("baseline");
    assert.ok(baseline);
    // A same-named leftover table makes the migration fail after its first statements ran.
    downgradeToV2(root, "CREATE TABLE component_versions (unexpected TEXT);");

    assert.throws(() => new WorkspaceStore(root).initialize(), /already exists/);
    const db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
    try {
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
      assert.deepEqual((db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ui_states', 'screen_frames', 'ui_states_last_seen')").all()), []);
      assert.deepEqual(db.prepare("PRAGMA table_info(component_versions)").all().map((column) => (column as { name: string }).name), ["unexpected"]);
      db.exec("DROP TABLE component_versions;");
    } finally { db.close(); }

    const recovered = new WorkspaceStore(root);
    recovered.initialize();
    assert.deepEqual(schemaOf(root), { version: 3, tables: UI_TABLES });
    assert.equal(recovered.readFile(baseline.id, "src/app.ts").toString(), "one");
  } finally { cleanup(); }
});

test("stores newer than version 3 are refused", () => {
  const { root, cleanup } = fixture();
  try {
    const db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
    db.exec("PRAGMA user_version = 4;");
    db.close();
    assert.throws(() => new WorkspaceStore(root).initialize(), /Unsupported store schema version 4/);
  } finally { cleanup(); }
});

test("UI states merge by route and visible components, and frames record component versions", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const first = store.snapshot("baseline");
    writeFileSync(join(root, "src", "app.ts"), "two");
    const second = store.snapshot("unattributed_group");
    assert.ok(first && second);

    const dialogSet = hex("App|Board|ItemDialog");
    const long = [{ click: "Close welcome" }, { click: "Item 2" }, { click: "Item 3" }];
    const state = store.upsertUiState({ origin: "learned", route: "/", path: long, componentSet: dialogSet, modules: ["src/ItemDialog.tsx"] });
    assert.equal(store.upsertUiState({ origin: "learned", route: "/", path: [...long, { key: "Escape" }], componentSet: dialogSet }).path.length, 3);
    assert.equal(store.upsertUiState({ origin: "learned", route: "/", path: long.slice(1), componentSet: dialogSet }).path.length, 2);
    store.markUiStatePathBroken(state.id);
    assert.equal(store.listUiStates()[0]!.status, "path_broken");
    const repaired = store.upsertUiState({ origin: "learned", route: "/", path: [...long, { key: "Escape" }], componentSet: dialogSet });
    assert.deepEqual([repaired.id, repaired.status, repaired.path.length], [state.id, "active", 4]);
    assert.equal(store.listUiStates().length, 1);

    const image = Buffer.from("png-bytes");
    const crop = Buffer.from("crop-bytes");
    const imageDigest = store.writeVisual(image);
    const cropDigest = store.writeVisual(crop);
    assert.deepEqual(store.readVisual(imageDigest), image);
    const box = { x: 40, y: 120, width: 240, height: 100 };
    store.recordScreenFrame({
      checkpointId: first.id, stateId: state.id, profileId: "mobile", status: "captured", captureMode: "live", imageDigest,
      components: [{ componentKey: "src/ItemDialog.tsx#ItemDialog", occurrence: 0, cropDigest, box }],
    });
    store.recordScreenFrame({
      checkpointId: second.id, stateId: state.id, profileId: "mobile", status: "unchanged", captureMode: "live", imageDigest,
      unchangedFrom: first.id,
      components: [{ componentKey: "src/ItemDialog.tsx#ItemDialog", occurrence: 0, cropDigest, unchangedFrom: first.id, box }],
    });
    store.recordScreenFrame({ checkpointId: second.id, stateId: state.id, profileId: "desktop", status: "path_broken", captureMode: "live", reason: "Item 2 not found" });

    assert.deepEqual(store.listScreenFrames(state.id, "mobile").map((frame) => [frame.checkpointId, frame.status, frame.unchangedFrom]),
      [[first.id, "captured", undefined], [second.id, "unchanged", first.id]]);
    assert.equal(store.listScreenFrames(state.id).length, 3);
    assert.deepEqual(store.listComponentVersions("src/ItemDialog.tsx#ItemDialog", "mobile").map((version) => [version.checkpointId, version.box]),
      [[first.id, box], [second.id, box]]);
    assert.deepEqual(store.listComponentVersions("src/ItemDialog.tsx#ItemDialog", "desktop"), []);

    // Frames with an image are final; an unreachable frame is retried and replaced by a later run.
    assert.equal(store.hasRenderedScreenFrame(second.id, state.id, "mobile"), true);
    assert.equal(store.hasRenderedScreenFrame(second.id, state.id, "desktop"), false);
    assert.throws(() => store.recordScreenFrame({ checkpointId: second.id, stateId: state.id, profileId: "mobile", status: "failed", captureMode: "live" }), /UNIQUE constraint/);
    store.recordScreenFrame({ checkpointId: second.id, stateId: state.id, profileId: "desktop", status: "failed", captureMode: "replayed", reason: "Timeout" });
    store.recordScreenFrame({ checkpointId: second.id, stateId: state.id, profileId: "desktop", status: "captured", captureMode: "replayed", imageDigest });
    assert.deepEqual(store.listScreenFrames(state.id, "desktop").map((frame) => [frame.checkpointId, frame.status, frame.captureMode]),
      [[second.id, "captured", "replayed"]]);
    assert.equal(store.hasRenderedScreenFrame(second.id, state.id, "desktop"), true);

    // Constraints: a frame is unique per checkpoint/state/profile, statuses must agree with digests, references must exist.
    const frame = { checkpointId: first.id, stateId: state.id, profileId: "tablet", captureMode: "live" as const };
    assert.throws(() => store.recordScreenFrame({ ...frame, status: "captured" }), /CHECK constraint/);
    assert.throws(() => store.recordScreenFrame({ ...frame, status: "unchanged", imageDigest }), /CHECK constraint/);
    assert.throws(() => store.recordScreenFrame({ ...frame, stateId: "missing", status: "skipped" }), /FOREIGN KEY/);
    assert.throws(() => store.recordScreenFrame({ ...frame, profileId: "Mobile!", status: "skipped" }), /Invalid screen frame/);
    assert.throws(() => store.recordScreenFrame({ ...frame, status: "failed", components: [{ componentKey: "a#B", occurrence: 0, cropDigest, box }] }), /captured frame/);
    assert.throws(() => store.recordScreenFrame({ ...frame, status: "captured", imageDigest, components: [{ componentKey: "a#B", occurrence: 0, cropDigest, box: { ...box, width: 0 } }] }), /Invalid component version/);
    assert.throws(() => store.recordScreenFrame({ ...frame, status: "captured", imageDigest, components: [
      { componentKey: "a#B", occurrence: 0, cropDigest, box }, { componentKey: "a#B", occurrence: 0, cropDigest, box },
    ] }), /UNIQUE constraint/);
    assert.equal(store.listScreenFrames(state.id, "tablet").length, 0, "a failed frame write leaves no partial rows");

    assert.throws(() => store.upsertUiState({ origin: "learned", route: "relative", path: [], componentSet: dialogSet }), /route/);
    assert.throws(() => store.upsertUiState({ origin: "learned", route: "/", path: [], componentSet: "short" }), /component set/);
    assert.throws(() => store.upsertUiState({ origin: "learned", route: "/", path: [], componentSet: dialogSet, modules: ["../escape"] }), /modules/);
    assert.throws(() => store.upsertUiState({ origin: "learned", route: "/", path: ["x".repeat(70_000)], componentSet: dialogSet }), /path/);

    writeFileSync(join(root, ".rewindry", "visuals", `${cropDigest}.png`), "tampered");
    assert.throws(() => store.readVisual(cropDigest), /Visual corrupt/);
    assert.throws(() => store.readVisual("../index"), /Invalid visual digest/);
  } finally { cleanup(); }
});

test("the UI state cap evicts the least recently seen state without history and never deletes history", () => {
  const { root, store, cleanup } = fixture();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const checkpoint = store.snapshot("baseline");
    assert.ok(checkpoint);
    const learn = (name: string) => store.upsertUiState({ origin: "learned", route: "/", path: [], componentSet: hex(name), components: [`src/${name}.tsx#${name}`] }, { maxStates: 2 });
    const kept = learn("A");
    store.recordScreenFrame({ checkpointId: checkpoint.id, stateId: kept.id, profileId: "mobile", status: "skipped", captureMode: "live" });
    learn("B");
    learn("C");
    assert.deepEqual(store.listUiStates().map((state) => state.components[0]).sort(), ["src/A.tsx#A", "src/C.tsx#C"]);
    store.recordScreenFrame({ checkpointId: checkpoint.id, stateId: store.listUiStates().find((state) => state.components[0] === "src/C.tsx#C")!.id, profileId: "mobile", status: "skipped", captureMode: "live" });
    assert.throws(() => learn("D"), /UI state limit reached/);
    assert.equal(store.listUiStates().length, 2);
    assert.equal(learn("A").id, kept.id, "an existing state still merges at the cap");
  } finally { cleanup(); }
});

test("manifest paths are recorded relative to the store, so a copied project reads old and new checkpoints", () => {
  const { root, store, cleanup } = fixture();
  const copy = mkdtempSync(join(tmpdir(), "rewindry-store-copy-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "one");
    const legacy = store.snapshot("baseline")!;
    writeFileSync(join(root, "src", "app.ts"), "two");
    const current = store.snapshot("agent_turn", "turn-2")!;
    let db = new DatabaseSync(join(root, ".rewindry", "index.sqlite"));
    assert.deepEqual(db.prepare("SELECT manifest_path AS path FROM checkpoints ORDER BY rowid").all().map((row) => (row as { path: string }).path),
      [`manifests/${legacy.id}.json`, `manifests/${current.id}.json`]);
    // Checkpoints written by earlier versions recorded the absolute path in the original project.
    db.prepare("UPDATE checkpoints SET manifest_path = ? WHERE id = ?").run(join(root, ".rewindry", "manifests", `${legacy.id}.json`), legacy.id);
    db.close();

    cpSync(root, copy, { recursive: true });
    const copied = new WorkspaceStore(copy);
    copied.initialize();
    assert.equal(copied.readFile(legacy.id, "src/app.ts").toString(), "one");
    assert.equal(copied.readFile(current.id, "src/app.ts").toString(), "two");

    // Any other recorded path is refused.
    db = new DatabaseSync(join(copy, ".rewindry", "index.sqlite"));
    db.prepare("UPDATE checkpoints SET manifest_path = ? WHERE id = ?").run(`manifests/${current.id}.json/../${legacy.id}.json`, current.id);
    db.close();
    assert.throws(() => copied.readFile(current.id, "src/app.ts"), /Manifest unavailable/);
  } finally {
    cleanup();
    rmSync(copy, { recursive: true, force: true });
  }
});
