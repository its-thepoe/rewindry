import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

type ConfigKind = 'cursor' | 'claude-code' | 'codex-cli';
type HookRecord = {
  kind: ConfigKind;
  path: string;
  original: string | null;
  mode: number;
  afterHash: string;
  commands: string[];
};
type HookRegistration = { schemaVersion: 1; root: string; entries: HookRecord[] };
type JsonObject = Record<string, unknown>;

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function command(nodePath: string, cliPath: string, provider: ConfigKind, hook: string, root: string, dataDir: string): string {
  return [nodePath, cliPath, 'hook', provider, hook, '--root', root, '--data-dir', dataDir]
    .map(quote).join(' ');
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported hook configuration');
  return value as JsonObject;
}

function readConfig(path: string): { value: JsonObject; original: string | null; mode: number } {
  if (!existsSync(path)) return { value: {}, original: null, mode: 0o600 };
  if (!lstatSync(path).isFile()) throw new Error(`Hook configuration is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  return { value: object(JSON.parse(bytes.toString('utf8'))), original: bytes.toString('base64'), mode: statSync(path).mode & 0o777 };
}

function writeConfig(path: string, bytes: Buffer | string, mode: number): void {
  const parent = dirname(path);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Hook directory is a symlink: ${parent}`);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { flag: 'wx', mode });
  renameSync(temp, path);
  chmodSync(path, mode);
}

function addCursor(config: JsonObject, commands: [string, string][]): void {
  if (config.version !== undefined && config.version !== 1) throw new Error('Unsupported Cursor hooks version');
  config.version = 1;
  const hooks = config.hooks === undefined ? {} : object(config.hooks);
  for (const [event, value] of commands) {
    const list = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(list)) throw new Error(`Invalid Cursor ${event} hooks`);
    if (!list.some((item) => object(item).command === value)) list.push({ command: value });
    hooks[event] = list;
  }
  config.hooks = hooks;
}

function addClaude(config: JsonObject, commands: [string, string][]): void {
  const hooks = config.hooks === undefined ? {} : object(config.hooks);
  for (const [event, value] of commands) {
    const groups = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(groups)) throw new Error(`Invalid Claude ${event} hooks`);
    const present = groups.some((group) => {
      const items = object(group).hooks;
      return Array.isArray(items) && items.some((item) => object(item).command === value);
    });
    if (!present) groups.push({ hooks: [{ type: 'command', command: value }] });
    hooks[event] = groups;
  }
  config.hooks = hooks;
}

function removeCommands(config: JsonObject, record: HookRecord): void {
  const hooks = object(config.hooks ?? {});
  for (const [event, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue;
    if (record.kind === 'cursor') {
      const kept = current.filter((item) => !record.commands.includes(String(object(item).command ?? '')));
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    } else {
      const groups = current.flatMap((group) => {
        const parsed = object(group);
        if (!Array.isArray(parsed.hooks)) return [group];
        const kept = parsed.hooks.filter((item) => !record.commands.includes(String(object(item).command ?? '')));
        return kept.length ? [{ ...parsed, hooks: kept }] : [];
      });
      if (groups.length) hooks[event] = groups;
      else delete hooks[event];
    }
  }
  config.hooks = hooks;
}

export function installHookConfigs(
  root: string, cliPath: string, nodePath: string, dataDir: string,
  kinds: ConfigKind[] = ['cursor', 'claude-code'],
  previousRoot?: string,
): void {
  const canonicalRoot = realpathSync(root);
  const registrationPath = join(dataDir, 'hooks.json');
  if (existsSync(registrationPath)) uninstallHookConfigs(canonicalRoot, dataDir, previousRoot);
  const supported: { kind: ConfigKind; path: string; hooks: string[] }[] = [
    { kind: 'cursor', path: join(canonicalRoot, '.cursor', 'hooks.json'), hooks: ['beforeSubmitPrompt', 'stop'] },
    { kind: 'claude-code', path: join(canonicalRoot, '.claude', 'settings.local.json'), hooks: ['UserPromptSubmit', 'Stop', 'StopFailure'] },
    { kind: 'codex-cli', path: join(canonicalRoot, '.codex', 'hooks.json'), hooks: ['UserPromptSubmit', 'Stop'] },
  ];
  const targets = supported.filter((target) => kinds.includes(target.kind));
  const prepared = targets.map(({ kind, path, hooks }) => {
    const { value, original, mode } = readConfig(path);
    const pairs = hooks.map((hook) => [hook, command(nodePath, cliPath, kind, hook, canonicalRoot, dataDir)] as [string, string]);
    if (kind === 'cursor') addCursor(value, pairs);
    else addClaude(value, pairs);
    const bytes = JSON.stringify(value, null, 2) + '\n';
    const record: HookRecord = {
      kind, path, original, mode, afterHash: hash(bytes), commands: pairs.map(([, value]) => value),
    };
    return { record, bytes };
  });
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const written: HookRecord[] = [];
  try {
    for (const item of prepared) {
      writeConfig(item.record.path, item.bytes, item.record.mode);
      written.push(item.record);
    }
    const registration: HookRegistration = { schemaVersion: 1, root: canonicalRoot, entries: prepared.map(({ record }) => record) };
    writeConfig(registrationPath, JSON.stringify(registration), 0o600);
  } catch (error) {
    for (const record of written.reverse()) restoreOriginal(record);
    throw error;
  }
}

function restoreOriginal(record: HookRecord): void {
  if (record.original === null) {
    if (existsSync(record.path)) unlinkSync(record.path);
  } else {
    writeConfig(record.path, Buffer.from(record.original, 'base64'), record.mode);
  }
}

export function uninstallHookConfigs(root: string, dataDir: string, previousRoot?: string): boolean {
  const registrationPath = join(dataDir, 'hooks.json');
  if (!existsSync(registrationPath)) return false;
  const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as HookRegistration;
  const canonicalRoot = realpathSync(root);
  const canonicalPreviousRoot = previousRoot && !existsSync(previousRoot)
    ? join(realpathSync(dirname(previousRoot)), basename(previousRoot))
    : undefined;
  if (registration.schemaVersion !== 1 || !Array.isArray(registration.entries) ||
      (registration.root !== canonicalRoot &&
      registration.root !== canonicalPreviousRoot)) {
    throw new Error('Hook registration does not match this workspace');
  }
  const records = registration.entries.map((record) => {
    if (registration.root === canonicalRoot) return record;
    const path = relative(canonicalPreviousRoot!, record.path);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Hook registration path cannot be rebased');
    }
    return { ...record, path: join(canonicalRoot, path) };
  });
  for (const record of records) {
    if (!existsSync(record.path)) continue;
    if (!lstatSync(record.path).isFile()) throw new Error(`Hook configuration is not a regular file: ${record.path}`);
    const current = readFileSync(record.path);
    if (hash(current) === record.afterHash) {
      restoreOriginal(record);
    } else {
      const value = object(JSON.parse(current.toString('utf8')));
      removeCommands(value, record);
      writeConfig(record.path, JSON.stringify(value, null, 2) + '\n', statSync(record.path).mode & 0o777);
    }
  }
  unlinkSync(registrationPath);
  return true;
}
