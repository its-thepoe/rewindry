import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const CHECKPOINT_ID = /^[a-f0-9-]{36}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function safePreviewFile(root: string, id: string, name: 'primary.json' | 'primary.png'): string | null {
  if (!CHECKPOINT_ID.test(id)) return null;
  const previews = join(root, '.rewindry', 'previews');
  const directory = join(previews, id);
  const file = join(directory, name);
  if (!existsSync(previews) || !lstatSync(previews).isDirectory() ||
      !existsSync(directory) || !lstatSync(directory).isDirectory() || !existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > (name === 'primary.png' ? MAX_IMAGE_BYTES : MAX_RECORD_BYTES)) return null;
  return file;
}
