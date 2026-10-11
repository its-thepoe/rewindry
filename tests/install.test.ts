import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LocalDaemon } from '../src/daemon.ts';
import { installWorkspace, uninstallWorkspace, type ServiceController } from '../src/install.ts';
import { WorkspaceStore } from '../src/store.ts';

test('setup copies a stable runtime, registers once, and uninstall preserves history', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-install-'));
  const root = join(temp, 'project & ui');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'user-data');
  const launchAgentsDir = join(temp, 'launch-agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  const actions: string[] = [];
  const service: ServiceController = {
    bootstrap: () => { actions.push('bootstrap'); },
    bootout: () => { actions.push('bootout'); },
  };
  try {
    mkdirSync(join(root, '.rewindry'), { recursive: true });
    writeFileSync(join(root, '.rewindry', 'history-marker'), 'keep');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(temp, 'node_modules', 'chokidar'), { recursive: true });
    mkdirSync(join(temp, 'node_modules', 'readdirp'));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0', type: 'module', dependencies: { chokidar: '1.0.0' } }));
    writeFileSync(sourceCli, 'console.log("stable runtime")');
    writeFileSync(join(temp, 'node_modules', 'chokidar', 'package.json'), JSON.stringify({ name: 'chokidar', version: '1.0.0', main: 'index.js', dependencies: { readdirp: '1.0.0' } }));
    writeFileSync(join(temp, 'node_modules', 'chokidar', 'index.js'), 'module.exports = {}');
    writeFileSync(join(temp, 'node_modules', 'readdirp', 'package.json'), JSON.stringify({ name: 'readdirp', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(temp, 'node_modules', 'readdirp', 'index.js'), 'module.exports = {}');
    const options = { dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin' as const, verifyStart: false };
    const first = await installWorkspace(root, options);
    assert.equal(first.status, 'installed');
    assert.equal(existsSync(join(first.runtimePath, 'dist', 'cli.js')), true);
    assert.equal(existsSync(join(first.runtimePath, 'node_modules', 'chokidar', 'index.js')), true);
    assert.equal(existsSync(join(first.runtimePath, 'node_modules', 'readdirp', 'index.js')), true);
    assert.equal(actions.join(','), 'bootstrap');
    const plistPath = join(launchAgentsDir, 'dev.rewindry.daemon.plist');
    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /project &amp; ui/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.ok(plist.includes(join(first.runtimePath, 'dist', 'cli.js')));
    const second = await installWorkspace(root, options);
    assert.equal(second.status, 'already_installed');
    assert.equal(actions.join(','), 'bootstrap');
    assert.equal(await uninstallWorkspace(root, options), true);
    assert.equal(actions.join(','), 'bootstrap,bootout');
    assert.equal(existsSync(plistPath), false);
    assert.equal(existsSync(join(dataDir, 'registration.json')), false);
    assert.equal(readFileSync(join(root, '.rewindry', 'history-marker'), 'utf8'), 'keep');
    assert.equal(await uninstallWorkspace(root, options), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('setup waits for a LaunchAgent that takes longer than three seconds to publish its socket', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-slow-launchagent-'));
  const root = join(temp, 'project');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  let daemon: LocalDaemon | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  const service: ServiceController = {
    bootstrap: () => {
      startupTimer = setTimeout(() => {
        daemon = new LocalDaemon(root, { dataDir });
        void daemon.start();
      }, 3_100);
    },
    bootout: () => {
      if (startupTimer) clearTimeout(startupTimer);
      void daemon?.close();
    },
  };
  try {
    mkdirSync(root);
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.2' }));
    writeFileSync(sourceCli, 'console.log(1)');
    const installed = await installWorkspace(root, {
      dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin',
    });
    assert.equal(installed.status, 'installed');
    assert.ok(daemon);
    await uninstallWorkspace(root, { dataDir, launchAgentsDir, service, platform: 'darwin' });
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    await daemon?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('setup registers multiple workspaces and uninstall removes only the selected root', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-install-protect-'));
  const root = join(temp, 'first');
  const other = join(temp, 'other');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  const service: ServiceController = { bootstrap: () => {}, bootout: () => {} };
  try {
    mkdirSync(root);
    mkdirSync(other);
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules'));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0' }));
    writeFileSync(sourceCli, 'console.log(1)');
    writeFileSync(join(packageRoot, 'dist', 'viewer.js'), 'viewer-v1');
    const options = { dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin' as const, verifyStart: false };
    await installWorkspace(root, options);
    await installWorkspace(other, options);
    const registryPath = join(dataDir, 'registration.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { root: string; roots: string[]; schemaVersion: number };
    assert.equal(registry.schemaVersion, 2);
    assert.equal(registry.root, realpathSync(root));
    assert.deepEqual(registry.roots, [realpathSync(root), realpathSync(other)]);
    assert.equal(await uninstallWorkspace(other, options), true);
    const remaining = JSON.parse(readFileSync(registryPath, 'utf8')) as { root: string; roots: string[] };
    assert.equal(remaining.root, realpathSync(root));
    assert.deepEqual(remaining.roots, [realpathSync(root)]);
    const plistPath = join(launchAgentsDir, 'dev.rewindry.daemon.plist');
    writeFileSync(plistPath, 'modified by another tool');
    await assert.rejects(uninstallWorkspace(root, options), /changed/);
    assert.equal(existsSync(join(dataDir, 'registration.json')), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('failed upgrade restores the previous LaunchAgent registration', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-upgrade-'));
  const root = join(temp, 'project');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  let rejectNextBootstrap = false;
  let bootstrapCount = 0;
  const service: ServiceController = {
    bootstrap: () => {
      bootstrapCount++;
      if (rejectNextBootstrap) {
        rejectNextBootstrap = false;
        throw new Error('launchctl failed');
      }
    },
    bootout: () => {},
  };
  try {
    mkdirSync(root);
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules'));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0' }));
    writeFileSync(sourceCli, 'console.log(1)');
    writeFileSync(join(packageRoot, 'dist', 'viewer.js'), 'viewer-v1');
    const options = { dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin' as const, verifyStart: false };
    await installWorkspace(root, options);
    const plistPath = join(launchAgentsDir, 'dev.rewindry.daemon.plist');
    const previous = readFileSync(plistPath, 'utf8');
    writeFileSync(join(packageRoot, 'dist', 'viewer.js'), 'viewer-v2');
    rejectNextBootstrap = true;
    await assert.rejects(installWorkspace(root, options), /launchctl failed/);
    assert.equal(readFileSync(plistPath, 'utf8'), previous);
    assert.equal(bootstrapCount, 3);
    assert.equal(existsSync(join(dataDir, 'registration.json')), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('setup reports oversized eligible source before registering a service', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-install-oversize-'));
  const root = join(temp, 'project');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  let bootstrapCount = 0;
  const service: ServiceController = { bootstrap: () => { bootstrapCount++; }, bootout: () => {} };
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.rewindry'));
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0' }));
    writeFileSync(sourceCli, 'console.log(1)');
    writeFileSync(join(root, '.rewindry', 'config.json'), JSON.stringify({ capture: { maxFileBytes: 8 } }));
    writeFileSync(join(root, 'src', 'large.ts'), 'more than eight bytes');
    await assert.rejects(installWorkspace(root, {
      dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin', verifyStart: false,
    }), /Eligible source exceeds maxFileBytes.*src\/large\.ts/);
    assert.equal(bootstrapCount, 0);
    assert.equal(existsSync(dataDir), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('denied service bootstrap leaves no registration and allows a later retry', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-denied-'));
  const root = join(temp, 'project');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  let denied = true;
  const service: ServiceController = {
    bootstrap: () => {
      if (denied) throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    },
    bootout: () => {},
  };
  try {
    mkdirSync(join(root, '.rewindry'), { recursive: true });
    writeFileSync(join(root, '.rewindry', 'history-marker'), 'keep');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0' }));
    writeFileSync(sourceCli, 'console.log(1)');
    const options = { dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin' as const, verifyStart: false };
    await assert.rejects(installWorkspace(root, options), /Operation not permitted/);
    assert.equal(existsSync(join(launchAgentsDir, 'dev.rewindry.daemon.plist')), false);
    assert.equal(existsSync(join(dataDir, 'registration.json')), false);
    assert.equal(readFileSync(join(root, '.rewindry', 'history-marker'), 'utf8'), 'keep');
    denied = false;
    assert.equal((await installWorkspace(root, options)).status, 'installed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('explicit moved-workspace rebind preserves version 1 history and rejects implicit reassignment', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewindry-moved-'));
  const root = join(temp, 'project');
  const moved = join(temp, 'moved-project');
  const packageRoot = join(temp, 'package');
  const dataDir = join(temp, 'data');
  const launchAgentsDir = join(temp, 'agents');
  const sourceCli = join(packageRoot, 'dist', 'cli.js');
  const service: ServiceController = { bootstrap: () => {}, bootout: () => {} };
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'before move');
    const store = new WorkspaceStore(root);
    store.initialize();
    const baseline = store.snapshot('baseline');
    assert.ok(baseline);
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rewindry', version: '0.1.0' }));
    writeFileSync(sourceCli, 'console.log(1)');
    const options = { dataDir, launchAgentsDir, sourceCli, service, platform: 'darwin' as const, verifyStart: false };
    await installWorkspace(root, options);
    db = new DatabaseSync(join(root, '.rewindry', 'index.sqlite'));
    db.exec('DROP TABLE checkpoint_files; PRAGMA user_version = 1;');
    db.close();
    db = undefined;
    assert.equal(existsSync(moved), false);
    renameSync(root, moved);
    await assert.rejects(installWorkspace(moved, options), /Workspace needs re-registration/);
    assert.equal((await installWorkspace(moved, { ...options, allowRebindMoved: true })).status, 'installed');
    const reopened = new WorkspaceStore(moved);
    reopened.initialize();
    assert.equal(reopened.readFile(baseline.id, 'src/app.ts').toString(), 'before move');
    assert.equal(reopened.list()[0]?.checkoutId, baseline.id);
    assert.deepEqual(reopened.listPathHistory('src/app.ts'), [baseline.id]);
    writeFileSync(join(moved, 'src', 'app.ts'), 'after move');
    assert.equal(reopened.snapshot('unattributed_group')?.checkoutId, baseline.id);
    assert.equal(await uninstallWorkspace(moved, options), true);
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
