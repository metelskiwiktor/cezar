import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWorktree, chooseForkBase } from './git-worktree.ts';
import { resolvePrForkBase, validatePrFork } from './pr-fork.ts';

const roots: string[] = [];
// Real git subprocesses need room under the full suite's concurrent Windows load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, `${name}.txt`), name);
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', name);
  return git(cwd, 'rev-parse', 'HEAD');
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-remote-base-')); roots.push(root);
  const remote = join(root, 'remote.git'), repo = join(root, 'repo'), peer = join(root, 'peer');
  git(root, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, repo);
  const sha = commit(repo, 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', remote, peer);
  return { root, repo, remote, peer, sha };
}
beforeEach(() => vi.stubEnv('CEZ_DRY_RUN', '0'));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

it.each(['local ahead', 'remote ahead', 'diverged'])('pins fetched origin when %s', async (shape) => {
  const { repo, peer, sha } = fixture();
  if (shape !== 'remote ahead') commit(repo, 'local');
  let expected = sha;
  if (shape !== 'local ahead') { expected = commit(peer, 'upstream'); git(peer, 'push', '-q', 'origin', 'main'); }
  const local = git(repo, 'rev-parse', 'HEAD');
  const base = await resolvePrForkBase(repo);
  expect(base.sha).toBe(expected); expect(base.targetBranch).toBe('main');
  const wt = await createWorktree(repo, 'new-task-123', base.sha);
  expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(expected);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(local);
});

it.each(['configured', 'remote default'])('honors %s develop and pins publication target separately from SHA', async (mode) => {
  const { repo, peer, remote } = fixture(); git(peer, 'checkout', '-qb', 'develop');
  const sha = commit(peer, 'develop'); git(peer, 'push', '-q', 'origin', 'develop');
  if (mode === 'remote default') git(repo, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  const base = await resolvePrForkBase(repo, mode === 'configured' ? 'develop' : undefined);
  expect(base).toMatchObject({ sha, targetBranch: 'develop' });
  expect(git(repo, 'branch', '--show-current')).toBe('main');
});

it.each(['missing origin', 'unreachable origin', 'missing branch'])('fails closed on %s even with local and stale remote refs', async (shape) => {
  const { repo, root } = fixture();
  if (shape === 'missing origin') git(repo, 'remote', 'remove', 'origin');
  if (shape === 'unreachable origin') git(repo, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
  if (shape === 'missing branch') {
    git(repo, 'branch', 'absent'); git(repo, 'update-ref', 'refs/remotes/origin/absent', 'HEAD');
  }
  await expect(resolvePrForkBase(repo, shape === 'missing branch' ? 'absent' : 'main')).rejects.toThrow('PR pre-flight failed');
});

it.each(['--upload-pack=bad', '-main', 'origin/--bad', 'main:other', 'HEAD~1'])('rejects unsafe target %s', async (base) => {
  const { repo } = fixture();
  await expect(resolvePrForkBase(repo, base)).rejects.toThrow('PR pre-flight failed');
});

it('keeps intentional local forks for non-PR work and controlled children', async () => {
  const { repo } = fixture(); commit(repo, 'local');
  expect(await chooseForkBase(repo, 'main', undefined, () => {})).toBe('main');
  git(repo, 'checkout', '-qb', 'cez/parent'); const sha = commit(repo, 'parent');
  const child = await createWorktree(repo, 'child-task-123', 'cez/parent');
  expect(git(child.path, 'rev-parse', 'HEAD')).toBe(sha);
});

it('reuses an existing dirty worktree unchanged despite a changed remote tip', async () => {
  const { repo, peer } = fixture(); const base = await resolvePrForkBase(repo);
  const wt = await createWorktree(repo, 'existing-task', base.sha);
  writeFileSync(join(wt.path, 'dirty.txt'), 'keep');
  commit(peer, 'later'); git(peer, 'push', '-q', 'origin', 'main');
  const refreshed = await resolvePrForkBase(repo); expect(refreshed.sha).not.toBe(base.sha);
  const again = await createWorktree(repo, 'existing-task', base.sha);
  expect(resolve(again.path)).toBe(resolve(wt.path));
  expect(again.branch).toBe(wt.branch); expect(again.baseBranch).toBe(base.sha);
  expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(base.sha);
  expect(git(wt.path, 'status', '--short')).toContain('dirty.txt');
  await expect(validatePrFork(wt.path, wt.branch, base)).resolves.toBe(refreshed.sha);
});

it('PR provenance guard rejects changed origin, wrong HEAD and missing ancestry', async () => {
  const { repo, peer, remote } = fixture(); const base = await resolvePrForkBase(repo);
  const wt = await createWorktree(repo, 'guard-task-123', base.sha);
  commit(wt.path, 'task');
  await expect(validatePrFork(wt.path, wt.branch, base)).resolves.toBe(base.sha);
  const foreign = commit(peer, 'foreign'); git(peer, 'push', '-q', 'origin', 'main');
  await resolvePrForkBase(repo);
  await expect(validatePrFork(wt.path, wt.branch, { ...base, sha: foreign })).rejects.toThrow();
  git(wt.path, 'checkout', '--detach', '-q');
  await expect(validatePrFork(wt.path, wt.branch, base)).rejects.toThrow();
  git(wt.path, 'checkout', '-q', wt.branch);
  git(repo, 'remote', 'set-url', 'origin', `${remote}-changed`);
  await expect(validatePrFork(wt.path, wt.branch, base)).rejects.toThrow('origin URL changed');
});

it('PR guard blocks a rewritten target which dropped the pinned fork', async () => {
  const { repo, remote, peer, sha } = fixture();
  const advanced = commit(peer, 'upstream'); git(peer, 'push', '-q', 'origin', 'main');
  const base = await resolvePrForkBase(repo); expect(base.sha).toBe(advanced);
  const wt = await createWorktree(repo, 'rewritten-task', base.sha);
  // Rewrite only this disposable bare fixture: no project reset/clean/force push.
  git(repo, '--git-dir', remote, 'update-ref', 'refs/heads/main', sha);
  await expect(validatePrFork(wt.path, wt.branch, base)).rejects.toThrow();
  expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(base.sha);
});
