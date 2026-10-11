import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type GitCommit = { id: string; parents: string[]; committedAt: string; subject: string };
export type GitHistory = {
  available: boolean;
  shallow: boolean;
  truncated: boolean;
  commits: GitCommit[];
};

const HASH = /^[a-f0-9]{40,64}$/;
const LIMIT = 2_000;

export function readGitHistory(root: string): GitHistory {
  if (!existsSync(join(root, '.git'))) return { available: false, shallow: false, truncated: false, commits: [] };
  try {
    const output = execFileSync('git', [
      '-C', root, 'log', '--all', '--no-color', `--max-count=${LIMIT + 1}`,
      '--format=%H%x00%P%x00%cI%x00%s',
    ], { encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024 });
    const lines = output.trimEnd() ? output.trimEnd().split('\n') : [];
    const commits = lines.slice(0, LIMIT).map((line) => {
      const [id, parentList, committedAt, subject] = line.split('\0');
      if (!id || !HASH.test(id) || committedAt === undefined || subject === undefined) {
        throw new Error('Invalid Git log output');
      }
      const parents = parentList ? parentList.split(' ') : [];
      if (!parents.every((parent) => HASH.test(parent))) throw new Error('Invalid Git parent ID');
      return { id, parents, committedAt, subject };
    });
    const shallow = execFileSync('git', ['-C', root, 'rev-parse', '--is-shallow-repository'], {
      encoding: 'utf8', timeout: 3_000, maxBuffer: 1024,
    }).trim() === 'true';
    return { available: true, shallow, truncated: lines.length > LIMIT, commits };
  } catch {
    return { available: false, shallow: false, truncated: false, commits: [] };
  }
}
