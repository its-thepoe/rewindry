#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDaemon, daemonSocketPath, previewConfigured, queryDaemon, sendHookEvent, userDataDir } from './daemon.ts';
import { installWorkspace, registeredWorkspace, registeredWorkspaces, uninstallWorkspace } from './install.ts';
import { normalizeHook, PROVIDER_CAPABILITIES, type Provider } from './adapters.ts';
import { WorkspaceStore } from './store.ts';
import { ViewerServer } from './api.ts';
import { installHookConfigs, uninstallHookConfigs } from './hooks.ts';
import { installViteIntegration, uninstallViteIntegration } from './vite-install.ts';
import { runBackfill } from './backfill.ts';

type CliIo = { out: (line: string) => void; error: (line: string) => void };
const defaultIo: CliIo = { out: console.log, error: console.error };

export type SetupPlan = {
  root: string;
  framework: 'vite' | 'unknown';
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  sourceStore: string;
  serviceMetadata: string;
  serviceRegistration: string;
  hookConfiguration: string;
  detectedAgents: { provider: string; version: string; status: 'supported' | 'not_verified' }[];
  candidateHookFiles: string[];
  permissions: string[];
  changesApplied: false;
};

type ManagedProvider = 'codex-cli' | 'cursor-ide' | 'claude-code';
type HookConfigProvider = 'codex-cli' | 'cursor' | 'claude-code';
type VersionRunner = (command: string) => string | null;
type CursorAppVersionReader = () => string | null;

const providerCommands: { provider: ManagedProvider; command: string; pattern: RegExp }[] = [
  { provider: 'codex-cli', command: 'codex', pattern: /^codex-cli\s+(\S+)$/ },
  { provider: 'cursor-ide', command: 'cursor', pattern: /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/ },
  { provider: 'claude-code', command: 'claude', pattern: /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/ },
];

function runVersionCommand(command: string): string | null {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 1_000 }).trim();
  } catch {
    return null;
  }
}

function readCursorAppVersion(): string | null {
  if (process.platform !== 'darwin') return null;
  const infoFiles = [
    '/Applications/Cursor.app/Contents/Info.plist',
    join(homedir(), 'Applications', 'Cursor.app', 'Contents', 'Info.plist'),
  ];
  for (const infoFile of infoFiles) {
    if (!existsSync(infoFile)) continue;
    try {
      return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoFile], {
        encoding: 'utf8', timeout: 1_000,
      }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function detectAgentVersions(
  run: VersionRunner = runVersionCommand,
  cursorAppVersion: CursorAppVersionReader = readCursorAppVersion,
): Partial<Record<ManagedProvider, string>> {
  const detected: Partial<Record<ManagedProvider, string>> = {};
  for (const { provider, command, pattern } of providerCommands) {
    const output = provider === 'cursor-ide'
      ? cursorAppVersion() ?? run(command)
      : run(command);
    const version = output && pattern.exec(output)?.[1];
    if (version) detected[provider] = version;
  }
  return detected;
}

export function verifiedHookProviders(versions: Partial<Record<ManagedProvider, string>>): HookConfigProvider[] {
  const providers: HookConfigProvider[] = [];
  if (versions['codex-cli'] && PROVIDER_CAPABILITIES['codex-cli'].verifiedVersions.includes(versions['codex-cli'])) {
    providers.push('codex-cli');
  }
  if (versions['cursor-ide'] && PROVIDER_CAPABILITIES['cursor-ide'].verifiedVersions.includes(versions['cursor-ide'])) {
    providers.push('cursor');
  }
  if (versions['claude-code'] && PROVIDER_CAPABILITIES['claude-code'].verifiedVersions.includes(versions['claude-code'])) {
    providers.push('claude-code');
  }
  return providers;
}

export function setupPlan(root: string, dataDir = userDataDir(), withHooks = false): SetupPlan {
  const canonicalRoot = realpathSync(root);
  const packagePath = join(canonicalRoot, 'package.json');
  let framework: SetupPlan['framework'] = 'unknown';
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.vite || pkg.devDependencies?.vite) framework = 'vite';
  }
  const packageManager = existsSync(join(canonicalRoot, 'pnpm-lock.yaml')) ? 'pnpm'
    : existsSync(join(canonicalRoot, 'yarn.lock')) ? 'yarn'
    : existsSync(join(canonicalRoot, 'bun.lock')) || existsSync(join(canonicalRoot, 'bun.lockb')) ? 'bun'
    : existsSync(join(canonicalRoot, 'package-lock.json')) ? 'npm' : 'unknown';
  const detectedVersions = detectAgentVersions();
  const hookProviders = verifiedHookProviders(detectedVersions);
  const detectedAgents = Object.entries(detectedVersions).map(([provider, version]) => ({
    provider,
    version: version!,
    status: hookProviders.includes(provider === 'cursor-ide' ? 'cursor' : provider as HookConfigProvider) ? 'supported' as const : 'not_verified' as const,
  }));
  return {
    root: canonicalRoot,
    framework,
    packageManager,
    sourceStore: join(canonicalRoot, '.rewindry'),
    serviceMetadata: join(dataDir, 'daemon.json'),
    serviceRegistration: join(homedir(), 'Library', 'LaunchAgents', 'dev.rewindry.daemon.plist'),
    hookConfiguration: hookProviders.length
      ? `Automatic hooks for verified providers: ${hookProviders.join(', ')}`
      : detectedAgents.length ? 'Detected agent(s), but none have a verified hook edition' : 'No supported agent CLI detected',
    detectedAgents,
    candidateHookFiles: [
      ...(hookProviders.includes('codex-cli') ? [join(canonicalRoot, '.codex', 'hooks.json')] : []),
      ...(hookProviders.includes('cursor') || withHooks ? [join(canonicalRoot, '.cursor', 'hooks.json')] : []),
      ...(hookProviders.includes('claude-code') || withHooks ? [join(canonicalRoot, '.claude', 'settings.local.json')] : []),
    ],
    permissions: [
      `Create local history in ${join(canonicalRoot, '.rewindry')}`,
      `Register a user-level LaunchAgent in ${join(homedir(), 'Library', 'LaunchAgents')}`,
      ...(framework === 'vite' ? ['Edit the project Vite config reversibly'] : []),
      ...hookProviders.map((provider) => `Merge ${provider} project hooks`),
    ],
    changesApplied: false,
  };
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === 'hook') {
      try {
        const root = option(rest, '--root', process.cwd());
        const dataDir = option(rest, '--data-dir', userDataDir());
        const provider = rest[0] as Provider;
        const hookName = rest[1];
        const explicitJson = rest.find((arg) => arg.startsWith('{'));
        let raw = explicitJson ?? '';
        if (!raw) {
          for await (const chunk of process.stdin) {
            raw += String(chunk);
            if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Hook payload is too large');
          }
        }
        const workspaceId = createHash('sha256').update(realpathSync(root)).digest('hex');
        const normalized = normalizeHook(provider, hookName ?? '', JSON.parse(raw), workspaceId);
        if (normalized) await sendHookEvent(daemonSocketPath(dataDir), normalized);
      } catch { /* Hooks must never interrupt the host agent. */ }
      if (rest[0] === 'codex-cli' && rest[1] === 'Stop') io.out('{}');
      return 0;
    }
    const root = option(rest, '--root', process.cwd());
    const dataDir = option(rest, '--data-dir', userDataDir());
    if (command === 'backfill') {
      if (!rest.includes('--run-historical-source')) {
        io.error('Backfill executes each checkpoint’s saved Vite config and application source in a temporary directory. Re-run with --run-historical-source to acknowledge historical code execution.');
        return 1;
      }
      const summary = await runBackfill(root, io);
      return summary.stopped ? 1 : 0;
    }
    if (command === 'setup') {
      if (rest.includes('--dry-run')) {
        const plan = setupPlan(root, dataDir, rest.includes('--hooks'));
        io.out(JSON.stringify(plan, null, 2));
        return 0;
      }
      if (rest.includes('--hooks')) {
        io.error('Cursor and Claude Code hooks are not installed: neither edition has passed a real turn-boundary probe. Verified Codex hooks are installed by normal setup.');
        return 1;
      }
      const detectedVersions = detectAgentVersions();
      const hookProviders = verifiedHookProviders(detectedVersions);
      const previousRoot = rest.includes('--rebind-moved') ? registeredWorkspace(dataDir) ?? undefined : undefined;
      for (const permission of setupPlan(root, dataDir).permissions) io.out(`Setup access: ${permission}`);
      const installed = await installWorkspace(root, {
        dataDir, sourceCli: fileURLToPath(import.meta.url),
        allowRebindMoved: rest.includes('--rebind-moved'),
      });
      io.out(`Source capture ${installed.status === 'already_installed' ? 'already active' : 'installed'} for ${realpathSync(root)}`);
      if (setupPlan(root, dataDir).framework === 'vite') {
        try {
          const integration = installViteIntegration(realpathSync(root), installed.runtimePath, previousRoot);
          io.out(integration === 'unsupported'
            ? 'Vite preview: unsupported config shape; use `rewindry viewer` for history'
            : `Vite preview: ${integration === 'installed' ? 'integrated' : 'already integrated'}; keep using the original dev command`);
        } catch (error) {
          io.error(`Vite preview integration unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (hookProviders.length) {
        try {
          installHookConfigs(realpathSync(root), join(installed.runtimePath, 'dist', 'cli.js'),
            realpathSync(process.execPath), dataDir, hookProviders, previousRoot);
          io.out(`Hooks installed automatically for verified providers: ${hookProviders.join(', ')}. Review any host project-trust prompt before capture begins.`);
        } catch (error) {
          io.error(`Agent hook integration unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const agent of Object.entries(detectedVersions)) {
        const [provider, version] = agent;
        if (!hookProviders.includes(provider === 'cursor-ide' ? 'cursor' : provider as HookConfigProvider)) {
          io.out(`${provider} ${version} detected; hook integration is not enabled until this edition passes real-host validation`);
        }
      }
      io.out(`Workspace registration: ${registeredWorkspaces(dataDir).length} workspace${registeredWorkspaces(dataDir).length === 1 ? '' : 's'} registered`);
      io.out(hookProviders.length ? `Agent boundary capture: ${hookProviders.join(', ')} verified; host trust may be required` : 'Agent boundary capture: unverified');
      io.out(previewConfigured(realpathSync(root)) ? 'Visual capture: configured, verification pending' : 'Visual capture: unavailable');
      return 0;
    }
    if (command === 'uninstall') {
      uninstallViteIntegration(root);
      uninstallHookConfigs(root, dataDir);
      const removed = await uninstallWorkspace(root, { dataDir });
      io.out(removed ? 'Integration removed. Source history preserved.' : 'No Rewindry integration was registered.');
      return 0;
    }
    if (command === 'serve') {
      const roots = registeredWorkspaces(dataDir);
      const daemon = new LocalDaemon(root, { dataDir, workspaceRoots: roots.length ? roots : [root] });
      await daemon.start();
      io.out(`Source capture active for ${realpathSync(root)} (${daemon.socketPath})`);
      await new Promise<void>((resolve) => {
        let closing = false;
        const close = () => {
          if (closing) return;
          closing = true;
          void daemon.close().finally(() => {
            process.off('SIGINT', close);
            process.off('SIGTERM', close);
            resolve();
          });
        };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
      });
      return 0;
    }
    if (command === 'viewer') {
      const store = new WorkspaceStore(root);
      store.initialize();
      const configPath = join(realpathSync(root), '.rewindry', 'config.json');
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as {
        preview?: { url?: string };
      } : null;
      const liveUrl = option(rest, '--live-url', config?.preview?.url ?? '');
      const viewer = new ViewerServer(root, store, liveUrl || undefined);
      io.out(await viewer.start());
      await new Promise<void>((resolve) => {
        let closing = false;
        const close = () => {
          if (closing) return;
          closing = true;
          void viewer.close().finally(() => {
            process.off('SIGINT', close);
            process.off('SIGTERM', close);
            resolve();
          });
        };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
      });
      return 0;
    }
    if (command === 'status' || command === 'doctor') {
      const canonicalRoot = realpathSync(root);
      const workspaceId = createHash('sha256').update(canonicalRoot).digest('hex');
      const response = await queryDaemon(daemonSocketPath(dataDir), { action: 'status', workspaceId }).catch(() => null);
      if (!response?.ok || !response.status) {
        const registered = registeredWorkspaces(dataDir);
        io.error(registered.some((registeredRoot) => !existsSync(registeredRoot))
          ? 'Workspace needs re-registration. Run setup --rebind-moved in the moved project.'
          : registered.length && !registered.includes(canonicalRoot)
            ? `Workspace is not registered. Registered roots: ${registered.join(', ')}`
            : 'Daemon offline. Source capture is not active.');
        return 1;
      }
      io.out(`Source capture: ${response.status.sourceCapture === 'paused_storage_full' ? 'paused, storage limit reached' : response.status.sourceCapture} (${response.status.checkpointCount} checkpoints)`);
      io.out(`Source storage: ${response.status.sourceStorageBytes} / ${response.status.sourceBudgetBytes} bytes`);
      io.out(`Workspace registration: ${registeredWorkspaces(dataDir).length} workspace${registeredWorkspaces(dataDir).length === 1 ? '' : 's'} registered`);
      io.out('Agent boundary capture: unverified');
      io.out(response.status.visualCapture === 'configured_unverified'
        ? 'Visual capture: configured, verification pending' : 'Visual capture: unavailable');
      if (command === 'doctor') {
        io.out(`Socket: ${daemonSocketPath(dataDir)}`);
        io.out(`Observed writes: ${response.status.observedWrites}`);
        for (const diagnostic of response.status.diagnostics) io.out(`Diagnostic: ${diagnostic}`);
      }
      return 0;
    }
    io.error('Usage: rewindry <setup|serve|viewer|backfill|status|doctor|uninstall> [--dry-run] [--hooks] [--rebind-moved] [--run-historical-source] [--root PATH] [--data-dir PATH]');
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.error(command === 'setup' && (error instanceof Error && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      /permission denied|operation not permitted/i.test(message))
      ? `Limited capture: background-service permission denied. ${message}` : message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
