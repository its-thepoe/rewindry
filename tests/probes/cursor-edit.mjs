import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { LocalDaemon } from '../../dist/daemon.js';
import { installHookConfigs, uninstallHookConfigs } from '../../dist/hooks.js';

const root = realpathSync(process.cwd());
const fixtureRoot = mkdtempSync(join(resolve('tests/probes'), 'cursor-edit-'));
const dataDir = mkdtempSync(join(tmpdir(), 'rewindry-cursor-daemon-'));
const storePath = join(root, '.rewindry');
const createdStore = !existsSync(storePath);
const relativeFile = `${relative(root, fixtureRoot)}/src/app.ts`;
const absoluteFile = join(fixtureRoot, 'src', 'app.ts');
const expected = "export const state = 'B';\n";
const cli = resolve('dist/cli.js');
let daemon;
let hooksInstalled = false;

try {
  mkdirSync(join(fixtureRoot, 'src'));
  writeFileSync(absoluteFile, "export const state = 'A';\n");
  installHookConfigs(root, cli, realpathSync(process.execPath), dataDir, ['cursor']);
  hooksInstalled = true;
  daemon = new LocalDaemon(root, { dataDir });
  await daemon.start();

  console.log(JSON.stringify({ ready: true, file: relativeFile, expected }));
  const deadline = Date.now() + 180_000;
  let result = null;
  while (Date.now() < deadline) {
    const turn = daemon.runtime.store.list().find((checkpoint) => checkpoint.kind === 'agent_turn');
    if (turn) {
      const current = readFileSync(absoluteFile, 'utf8');
      const historical = daemon.runtime.store.readFile(turn.id, relativeFile).toString('utf8');
      result = {
        turnKey: turn.turnKey,
        current,
        historical,
        diagnostics: daemon.runtime.turns.diagnostics,
      };
      if (current === expected && historical === expected) break;
      result = null;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result) process.exitCode = 1;
} finally {
  await daemon?.close();
  if (hooksInstalled) uninstallHookConfigs(root, dataDir);
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
  if (createdStore && existsSync(storePath)) rmSync(storePath, { recursive: true, force: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
}
