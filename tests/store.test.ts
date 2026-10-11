import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    db.exec("DROP TABLE checkpoint_files; PRAGMA user_version = 1;");
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
