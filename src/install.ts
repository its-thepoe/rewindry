import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { daemonSocketPath, queryDaemon, userDataDir } from './daemon.ts';
import { WorkspaceStore } from './store.ts';

const LABEL = 'dev.rewindry.daemon';

export type ServiceController = {
  bootstrap(plistPath: string): void;
  bootout(plistPath: string): void;
};

const systemService: ServiceController = {
  bootstrap: (plistPath) => {
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, plistPath]);
  },
  bootout: (plistPath) => {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath]);
  },
};

export type InstallOptions = {
  dataDir?: string;
  launchAgentsDir?: string;
  sourceCli?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  service?: ServiceController;
  verifyStart?: boolean;
  allowRebindMoved?: boolean;
};

type Registration = {
  schemaVersion: 2;
  root: string;
  roots: string[];
  version: string;
  runtimePath: string;
  nodePath: string;
  plistPath: string;
  plistDigest: string;
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function writeAtomic(path: string, value: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temp, value, { flag: 'wx', mode });
  renameSync(temp, path);
}

function readRegistration(path: string): Registration | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: number; root?: string; roots?: unknown; version?: string;
    runtimePath?: string; nodePath?: string; plistPath?: string; plistDigest?: string;
  };
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.root !== 'string' ||
      typeof value.plistPath !== 'string' || typeof value.plistDigest !== 'string') {
    throw new Error('Invalid Rewindry registration');
  }
  const roots = value.schemaVersion === 2 ? value.roots : [value.root];
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string') || !roots.includes(value.root)) {
    throw new Error('Invalid Rewindry workspace registry');
  }
  return {
    schemaVersion: 2, root: value.root, roots, version: value.version ?? '0.0.0',
    runtimePath: value.runtimePath ?? '', nodePath: value.nodePath ?? '',
    plistPath: value.plistPath, plistDigest: value.plistDigest,
  };
}

export function registeredWorkspace(dataDir = userDataDir()): string | null {
  return readRegistration(join(dataDir, 'registration.json'))?.root ?? null;
}

export function registeredWorkspaces(dataDir = userDataDir()): string[] {
  return readRegistration(join(dataDir, 'registration.json'))?.roots ?? [];
}

function plist(root: string, nodePath: string, cliPath: string, dataDir: string): string {
  const args = [nodePath, cliPath, 'serve', '--root', root, '--data-dir', dataDir];
  const argXml = args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(dataDir, 'daemon.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dataDir, 'daemon.stderr.log'))}</string>
</dict>
</plist>
`;
}

function packageRoot(entryPath: string, expectedName: string): string {
  let current = dirname(entryPath);
  while (current !== dirname(current)) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (manifest.name === expectedName) return current;
    }
    current = dirname(current);
  }
  throw new Error(`Cannot locate installed dependency ${expectedName}`);
}

function runtimeDependencies(sourcePackage: string, names: string[]): Map<string, string> {
  const selected = new Map<string, { source: string; version: string }>();
  const visit = (name: string, fromPackage: string): void => {
    const resolveFrom = createRequire(join(fromPackage, 'package.json'));
    let source: string;
    try { source = packageRoot(resolveFrom.resolve(name), name); }
    catch { throw new Error(`Missing runtime dependency ${name}`); }
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const previous = selected.get(name);
    if (previous && previous.version !== manifest.version) throw new Error(`Conflicting runtime dependency ${name}`);
    if (previous) return;
    selected.set(name, { source, version: manifest.version ?? 'unknown' });
    for (const child of Object.keys(manifest.dependencies ?? {})) visit(child, source);
    for (const child of Object.keys(manifest.optionalDependencies ?? {})) {
      try { visit(child, source); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Missing runtime dependency')) throw error;
      }
    }
  };
  for (const name of names) visit(name, sourcePackage);
  return new Map([...selected].map(([name, value]) => [name, value.source]));
}

function hashDirectory(path: string): string {
  const digest = createHash('sha256');
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime source contains symlink: ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        digest.update(relativePath).update('\0').update(readFileSync(absolutePath));
      }
    }
  };
  visit(path, '');
  return digest.digest('hex');
}

function copyRuntimeDependencies(dependencies: Map<string, string>, destination: string): void {
  for (const [name, source] of dependencies) {
    const target = join(destination, 'node_modules', name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

async function verifyDaemon(dataDir: string, root: string): Promise<void> {
  const workspaceId = createHash('sha256').update(root).digest('hex');
  const deadline = Date.now() + 30_000;
  let lastState = 'no status response';
  while (Date.now() < deadline) {
    const response = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId }, 200).catch((error: unknown) => {
      lastState = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (response?.ok && response.status?.root === root) return;
    if (response && !response.ok) lastState = response.error;
    else if (response?.ok) lastState = `daemon reports ${response.status?.root ?? 'no root'}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`LaunchAgent did not start source capture: ${lastState}`);
}

function locations(options: InstallOptions): { dataDir: string; launchAgentsDir: string; registrationPath: string; plistPath: string } {
  const dataDir = options.dataDir ?? userDataDir();
  const launchAgentsDir = options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
  return { dataDir, launchAgentsDir, registrationPath: join(dataDir, 'registration.json'), plistPath: join(launchAgentsDir, `${LABEL}.plist`) };
}

export async function installWorkspace(root: string, options: InstallOptions = {}): Promise<{ status: 'installed' | 'already_installed'; runtimePath: string }> {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Persistent setup currently supports macOS only');
  const canonicalRoot = realpathSync(root);
  const existingHistory = existsSync(join(canonicalRoot, '.rewindry', 'index.sqlite'));
  const preflightStore = new WorkspaceStore(canonicalRoot);
  preflightStore.initialize();
  preflightStore.currentDigest();
  const { dataDir, launchAgentsDir, registrationPath, plistPath } = locations(options);
  const sourceCli = realpathSync(options.sourceCli ?? process.argv[1]!);
  const sourcePackage = dirname(dirname(sourceCli));
  const packagePath = join(sourcePackage, 'package.json');
  const distPath = join(sourcePackage, 'dist');
  if (!existsSync(packagePath) || !existsSync(distPath)) {
    throw new Error('Built package with dist/ is required for setup');
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    name?: string; version?: string; dependencies?: Record<string, string>;
  };
  if (packageJson.name !== 'rewindry' || !packageJson.version) throw new Error('Invalid Rewindry package');
  const existing = readRegistration(registrationPath);
  let roots = existing?.roots ?? [];
  if (existing && !roots.includes(canonicalRoot) && !existsSync(existing.root)) {
    if (!options.allowRebindMoved || !existingHistory) {
      throw new Error(`Workspace needs re-registration after moving from ${existing.root}; run setup --rebind-moved in the moved project`);
    }
    preflightStore.rebaseManifestPaths(existing.root);
    roots = roots.map((registeredRoot) => registeredRoot === existing.root ? canonicalRoot : registeredRoot);
  } else if (!roots.includes(canonicalRoot)) {
    roots = [...roots, canonicalRoot];
  }
  if (!roots.length) roots = [canonicalRoot];
  const primaryRoot = existing && roots.includes(existing.root) ? existing.root : canonicalRoot;
  if (!existing) {
    const active = await queryDaemon(daemonSocketPath(dataDir), { action: 'status' }, 200).catch(() => null);
    if (active?.ok) throw new Error('A manual daemon is already running; stop it before persistent setup');
  }
  const dependencies = runtimeDependencies(sourcePackage, Object.keys(packageJson.dependencies ?? {}));
  const fingerprint = createHash('sha256')
    .update(readFileSync(packagePath))
    .update(hashDirectory(distPath));
  for (const [name, source] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    fingerprint.update(name).update(hashDirectory(source));
  }
  const bundleDigest = fingerprint.digest('hex').slice(0, 16);
  const runtimePath = join(dataDir, 'runtime', packageJson.version, bundleDigest);
  const stableCli = join(runtimePath, 'dist', basename(sourceCli));
  const nodePath = realpathSync(options.nodePath ?? process.execPath);
  const contents = plist(primaryRoot, nodePath, stableCli, dataDir);
  const plistDigest = sha256(contents);
  if (existing?.roots.includes(canonicalRoot) && existing.runtimePath === runtimePath && existing.plistDigest === plistDigest &&
      existsSync(plistPath) && sha256(readFileSync(plistPath)) === plistDigest) {
    if (options.verifyStart === false) return { status: 'already_installed', runtimePath };
    const workspaceId = createHash('sha256').update(canonicalRoot).digest('hex');
    const response = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId }, 200).catch(() => null);
    if (response?.ok && response.status?.root === canonicalRoot) return { status: 'already_installed', runtimePath };
  }

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(launchAgentsDir)) mkdirSync(launchAgentsDir, { recursive: true, mode: 0o700 });
  if (!existsSync(runtimePath)) {
    const parent = dirname(runtimePath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = join(parent, `.${bundleDigest}.${process.pid}.tmp`);
    if (existsSync(temp)) throw new Error('Runtime staging path is occupied');
    mkdirSync(temp, { mode: 0o700 });
    try {
      cpSync(packagePath, join(temp, 'package.json'));
      cpSync(distPath, join(temp, 'dist'), { recursive: true });
      copyRuntimeDependencies(dependencies, temp);
      renameSync(temp, runtimePath);
    } finally {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    }
  }
  if (!existsSync(stableCli) || !statSync(stableCli).isFile()) throw new Error('Stable CLI is missing');
  if (existing && existsSync(plistPath) && sha256(readFileSync(plistPath)) !== existing.plistDigest) {
    throw new Error('LaunchAgent changed since Rewindry installed it');
  }
  if (!existing && existsSync(plistPath)) throw new Error('LaunchAgent path is already occupied');

  const service = options.service ?? systemService;
  const previousPlist = existing && existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : null;
  const previousRegistration = existing && existsSync(registrationPath) ? readFileSync(registrationPath, 'utf8') : null;
  if (existing) {
    try { service.bootout(plistPath); } catch { /* A stopped service has nothing to unload. */ }
  }
  try {
    const registration: Registration = {
      schemaVersion: 2, root: primaryRoot, roots, version: packageJson.version,
      runtimePath, nodePath, plistPath, plistDigest,
    };
    writeAtomic(registrationPath, JSON.stringify(registration), 0o600);
    writeAtomic(plistPath, contents, 0o600);
    service.bootstrap(plistPath);
    if (options.verifyStart !== false) await verifyDaemon(dataDir, canonicalRoot);
    return { status: 'installed', runtimePath };
  } catch (error) {
    try { service.bootout(plistPath); } catch { /* Preserve the original failure. */ }
    if (existsSync(plistPath) && sha256(readFileSync(plistPath)) === plistDigest) unlinkSync(plistPath);
    if (previousPlist !== null) {
      writeAtomic(plistPath, previousPlist, 0o600);
      try { service.bootstrap(plistPath); } catch { /* The original registration remains available for diagnosis. */ }
    }
    if (previousRegistration !== null) writeAtomic(registrationPath, previousRegistration, 0o600);
    else if (existsSync(registrationPath)) unlinkSync(registrationPath);
    throw error;
  }
}

export async function uninstallWorkspace(root: string, options: InstallOptions = {}): Promise<boolean> {
  const canonicalRoot = realpathSync(root);
  const { registrationPath, plistPath } = locations(options);
  const registration = readRegistration(registrationPath);
  if (!registration) return false;
  if (!registration.roots.includes(canonicalRoot)) throw new Error('This workspace is not registered with Rewindry');
  if (!existsSync(plistPath) || sha256(readFileSync(plistPath)) !== registration.plistDigest) {
    throw new Error('LaunchAgent changed since Rewindry installed it');
  }
  const service = options.service ?? systemService;
  if (registration.roots.length > 1) {
    const roots = registration.roots.filter((registeredRoot) => registeredRoot !== canonicalRoot);
    const primaryRoot = roots.includes(registration.root) ? registration.root : roots[0]!;
    const stableCli = join(registration.runtimePath, 'dist', 'cli.js');
    const contents = plist(primaryRoot, registration.nodePath || process.execPath, stableCli, locations(options).dataDir);
    const next: Registration = {
      ...registration, root: primaryRoot, roots, plistDigest: sha256(contents),
    };
    const previousPlist = readFileSync(plistPath, 'utf8');
    const previousRegistration = readFileSync(registrationPath, 'utf8');
    try {
      try { service.bootout(plistPath); } catch { /* It may already be stopped. */ }
      writeAtomic(plistPath, contents, 0o600);
      writeAtomic(registrationPath, JSON.stringify(next), 0o600);
      service.bootstrap(plistPath);
      if (options.verifyStart !== false) await verifyDaemon(locations(options).dataDir, primaryRoot);
      return true;
    } catch (error) {
      try { service.bootout(plistPath); } catch { /* Preserve the original failure. */ }
      writeAtomic(plistPath, previousPlist, 0o600);
      writeAtomic(registrationPath, previousRegistration, 0o600);
      try { service.bootstrap(plistPath); } catch { /* Keep the previous registration available. */ }
      throw error;
    }
  }
  try { service.bootout(plistPath); } catch { /* It may already be stopped. */ }
  unlinkSync(plistPath);
  unlinkSync(registrationPath);
  return true;
}
