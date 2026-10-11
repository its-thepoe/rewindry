import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readGitHistory } from '../src/git-history.ts';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

test('Git import reads parent graph and leaves refs and dirty source untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'rewindry-git-'));
  const shallow = mkdtempSync(join(tmpdir(), 'rewindry-shallow-'));
  try {
    assert.equal(readGitHistory(root).available, false);
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Rewindry Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'app.txt'), 'first\n');
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-qm', 'First state');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'app.txt'), 'second\n');
    git(root, 'commit', '-qam', 'Second state');
    const second = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'app.txt'), 'dirty working state\n');
    const dirtyBefore = git(root, 'status', '--porcelain');
    const history = readGitHistory(root);
    assert.equal(history.available, true);
    assert.equal(history.shallow, false);
    assert.equal(history.commits[0]?.id, second);
    assert.deepEqual(history.commits[0]?.parents, [first]);
    assert.equal(history.commits[0]?.subject, 'Second state');
    assert.equal(history.commits[1]?.id, first);
    assert.deepEqual(history.commits[1]?.parents, []);
    assert.equal(git(root, 'status', '--porcelain'), dirtyBefore);
    assert.equal(git(root, 'rev-parse', 'HEAD'), second);

    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, shallow]);
    const shallowHistory = readGitHistory(shallow);
    assert.equal(shallowHistory.available, true);
    assert.equal(shallowHistory.shallow, true);
    assert.equal(shallowHistory.commits.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  }
});
