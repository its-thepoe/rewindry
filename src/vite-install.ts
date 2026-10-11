import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

type Integration = {
  schemaVersion: 1;
  configPath: string;
  original: string;
  installedDigest: string;
};

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeAtomic(path: string, value: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, value, { flag: 'wx' });
  renameSync(temporary, path);
}

function metadataPath(root: string): string {
  return join(root, '.rewindry', 'vite-integration.json');
}

function readIntegration(root: string, previousRoot?: string): Integration | null {
  const path = metadataPath(root);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error('Vite integration metadata is not a regular file');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Integration;
  if (value.schemaVersion !== 1 || typeof value.configPath !== 'string' ||
      typeof value.original !== 'string' || typeof value.installedDigest !== 'string') {
    throw new Error('Invalid Vite integration metadata');
  }
  if (!CONFIG_NAMES.includes(basename(value.configPath)) ||
      ![root, previousRoot].includes(dirname(value.configPath))) {
    throw new Error('Vite integration points outside workspace');
  }
  return value;
}

function objectConfig(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const declarations = source.statements.filter(ts.isExportAssignment);
  if (declarations.length !== 1) return null;
  let expression: ts.Expression = declarations[0]!.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'defineConfig' && expression.arguments.length === 1) {
    expression = expression.arguments[0]!;
  }
  return ts.isObjectLiteralExpression(expression) ? expression : null;
}

function addPlugin(sourceText: string, configPath: string, pluginPath: string, appId: string): string | null {
  const parsed = ts.transpileModule(sourceText, { fileName: configPath, reportDiagnostics: true });
  if (parsed.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return null;
  const source = ts.createSourceFile(configPath, sourceText, ts.ScriptTarget.Latest, true);
  const config = objectConfig(source);
  if (!config) return null;
  const properties = config.properties.filter((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(source) === 'plugins',
  ) as ts.PropertyAssignment[];
  if (properties.length !== 1 || !ts.isArrayLiteralExpression(properties[0]!.initializer)) return null;
  const array = properties[0]!.initializer as ts.ArrayLiteralExpression;
  const before = sourceText.slice(0, array.elements.end);
  const after = sourceText.slice(array.elements.end);
  const call = `rewindryPreviewPlugin(${JSON.stringify(appId)})`;
  const item = `${array.elements.length ? (before.trimEnd().endsWith(',') ? ' ' : ', ') : ''}${call}`;
  const importLine = `import { rewindryPreviewPlugin } from ${JSON.stringify(pluginPath)};\n`;
  return `${importLine}${before}${item}${after}`;
}

export function installViteIntegration(root: string, runtimePath: string, previousRoot?: string): 'installed' | 'already_installed' | 'unsupported' {
  const canonicalRoot = resolve(root);
  const candidates = CONFIG_NAMES.filter((name) => existsSync(join(canonicalRoot, name)));
  if (candidates.length !== 1) return 'unsupported';
  const configPath = join(canonicalRoot, candidates[0]!);
  if (!lstatSync(configPath).isFile()) throw new Error('Vite config is not a regular file');
  const prior = readIntegration(canonicalRoot, previousRoot);
  const current = readFileSync(configPath, 'utf8');
  if (prior && (basename(prior.configPath) !== basename(configPath) || digest(current) !== prior.installedDigest)) {
    throw new Error('Vite config changed after Rewindry setup; integration was preserved');
  }
  const original = prior?.original ?? current;
  if (!prior && /rewindryPreviewPlugin|rewindry\/vite-plugin/.test(original)) return 'unsupported';
  const appId = `rewindry-${digest(canonicalRoot).slice(0, 12)}`;
  const pluginPath = join(runtimePath, 'dist', 'vite-plugin.js');
  const installed = addPlugin(original, configPath, pluginPath, appId);
  if (installed === null) return 'unsupported';
  if (prior && current === installed) return 'already_installed';
  const metadata: Integration = { schemaVersion: 1, configPath, original, installedDigest: digest(installed) };
  writeAtomic(configPath, installed);
  try {
    writeAtomic(metadataPath(canonicalRoot), JSON.stringify(metadata));
  } catch (error) {
    writeAtomic(configPath, current);
    throw error;
  }
  return 'installed';
}

export function uninstallViteIntegration(root: string): boolean {
  const canonicalRoot = resolve(root);
  const metadata = readIntegration(canonicalRoot);
  if (!metadata) return false;
  if (!existsSync(metadata.configPath)) throw new Error('Vite config is missing; integration was preserved');
  if (!lstatSync(metadata.configPath).isFile()) throw new Error('Vite config is not a regular file');
  const current = readFileSync(metadata.configPath, 'utf8');
  if (digest(current) !== metadata.installedDigest) {
    throw new Error('Vite config changed after Rewindry setup; integration was preserved');
  }
  writeAtomic(metadata.configPath, metadata.original);
  const path = metadataPath(canonicalRoot);
  unlinkSync(path);
  return true;
}
