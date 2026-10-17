import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;
const TARGET_IMAGE = /^[a-z0-9][a-z0-9-]{0,47}--[a-z0-9][a-z0-9-]{0,47}\.png$/;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function safePreviewFile(root: string, id: string, name: string): string | null {
  const allowedName = ['primary.json', 'primary.png'].includes(name) || TARGET_IMAGE.test(name);
  if (!CHECKPOINT_ID.test(id) || !allowedName) return null;
  const previews = join(root, '.rewindry', 'previews');
  const directory = join(previews, id);
  const file = join(directory, name);
  if (!existsSync(previews) || !lstatSync(previews).isDirectory() ||
      !existsSync(directory) || !lstatSync(directory).isDirectory() || !existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > (name === 'primary.json' ? MAX_RECORD_BYTES : MAX_IMAGE_BYTES)) return null;
  return file;
}
