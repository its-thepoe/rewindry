import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const source = join(process.cwd(), 'src', 'viewer');
const target = join(process.cwd(), 'dist', 'viewer');

if (!existsSync(source)) throw new Error('Viewer assets are missing');
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, force: true });
for (const name of ['overlay.js', 'overlay.css', 'component-collector.js', 'recorder.js']) {
  const asset = join(process.cwd(), 'src', name);
  if (!existsSync(asset)) throw new Error(`Missing ${name}`);
  // A same-named .ts source compiles to the same dist path; copying would overwrite that module.
  if (name.endsWith('.js') && existsSync(join(process.cwd(), 'src', name.replace(/\.js$/, '.ts')))) {
    throw new Error(`Asset ${name} would overwrite compiled src/${name.replace(/\.js$/, '.ts')}`);
  }
  copyFileSync(asset, join(process.cwd(), 'dist', name));
}
chmodSync(join(process.cwd(), 'dist', 'cli.js'), 0o755);
