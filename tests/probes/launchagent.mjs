import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { daemonSocketPath, queryDaemon } from '../../dist/daemon.js';
import { installWorkspace, uninstallWorkspace } from '../../dist/install.js';

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rewindry-agent-')));
const root = join(temp, 'project');
const secondRoot = join(temp, 'second-project');
const dataDir = join(temp, 'data');
const launchAgentsDir = join(temp, 'agents');
const serviceId = `gui/${process.getuid()}/dev.rewindry.daemon`;
const installedRoots = [];
try {
  try {
    execFileSync('launchctl', ['print', serviceId], { stdio: 'ignore' });
    throw new Error('Rewindry service label is already in use; refusing probe');
  } catch (error) {
    if (error instanceof Error && error.message.includes('already in use')) throw error;
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.txt'), 'Initial state\n');
  mkdirSync(join(secondRoot, 'src'), { recursive: true });
  writeFileSync(join(secondRoot, 'src', 'app.txt'), 'Second initial state\n');
  const options = { dataDir, launchAgentsDir, sourceCli: resolve('dist/cli.js') };
  const setup = await installWorkspace(root, options);
  installedRoots.push(root);
  assert.equal(setup.status, 'installed');
  const secondSetup = await installWorkspace(secondRoot, options);
  installedRoots.push(secondRoot);
  assert.equal(secondSetup.status, 'installed');
  const first = await queryDaemon(daemonSocketPath(dataDir), { action: 'status' });
  assert.equal(first.ok, true);
  assert.equal(first.status?.checkpointCount, 1);
  const secondId = createHash('sha256').update(realpathSync(secondRoot)).digest('hex');
  const second = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId: secondId });
  assert.equal(second.ok, true);
  assert.equal(second.status?.checkpointCount, 1);
  const firstPid = first.status?.pid;
  execFileSync('launchctl', ['kickstart', '-k', serviceId]);
  let restarted = null;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    restarted = await queryDaemon(daemonSocketPath(dataDir), { action: 'status' }, 300).catch(() => null);
    if (restarted?.ok && restarted.status?.pid !== firstPid) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(restarted?.ok, true);
  assert.notEqual(restarted?.status?.pid, firstPid);
  assert.equal(restarted?.status?.checkpointCount, 1);
  const secondAfterRestart = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId: secondId });
  assert.equal(secondAfterRestart.ok, true);
  assert.equal(secondAfterRestart.status?.checkpointCount, 1);
  assert.equal(readFileSync(join(root, 'src', 'app.txt'), 'utf8'), 'Initial state\n');
  assert.equal(await uninstallWorkspace(root, options), true);
  installedRoots.splice(installedRoots.indexOf(root), 1);
  const remaining = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId: secondId });
  assert.equal(remaining.ok, true);
  assert.equal(remaining.status?.root, realpathSync(secondRoot));
  console.log(JSON.stringify({ installed: true, restarted: true, workspaceCount: 2, independentRemoval: true }, null, 2));
} catch (error) {
  const stderr = join(dataDir, 'daemon.stderr.log');
  if (existsSync(stderr)) console.error('daemon stderr:', readFileSync(stderr, 'utf8'));
  const stdout = join(dataDir, 'daemon.stdout.log');
  if (existsSync(stdout)) console.error('daemon stdout:', readFileSync(stdout, 'utf8'));
  const metadata = join(dataDir, 'daemon.json');
  if (existsSync(metadata)) console.error('daemon metadata:', readFileSync(metadata, 'utf8'));
  console.error('resolved socket:', daemonSocketPath(dataDir));
  try { console.error(execFileSync('launchctl', ['print', serviceId], { encoding: 'utf8' })); } catch (launchError) {
    console.error(launchError instanceof Error ? launchError.message : String(launchError));
  }
  throw error;
} finally {
  for (const installedRoot of installedRoots.reverse()) {
    await uninstallWorkspace(installedRoot, { dataDir, launchAgentsDir });
  }
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
