import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../runs/store.ts';
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ghCalls = vi.hoisted(() => [] as string[][]);
const ghHandler = vi.hoisted(() => ({
  fn: null as ((args: string[]) => { err?: Error | null; stdout?: string; stderr?: string }) | null,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: unknown[]) => {
    if (args[0] === 'gh') {
      const argv = args[1] as string[];
      ghCalls.push(argv);
      const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
      if (ghHandler.fn) {
        const res = ghHandler.fn(argv);
        callback(res.err ?? null, res.stdout ?? '', res.stderr ?? '');
        return;
      }
      callback(null, 'https://github.com/test/repo/pull/1\n', '');
      return;
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(...args);
  };
  // The promise-based git helpers keep Node's { stdout, stderr } result contract.
  Object.defineProperty(execFile, promisify.custom, { value: promisify(actual.execFile) });
  return { ...actual, execFile };
});
import { resolvePrForkBase } from '../../pr-fork.ts';
import { createDraftPr, prTargetRemote } from './github.ts';
import { taskRemotes } from '../../git-worktree.ts';

let root: string;
let repo: string;
let remote: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0'); ghCalls.length = 0; ghHandler.fn = null;
  root = mkdtempSync(join(tmpdir(), 'cez-pr-publish-')); repo = root;
  remote = join(root, 'remote.git');
  git('init', '--bare', '-q', '-b', 'main', remote);
  git('init', '-q', '-b', 'develop');
  writeFileSync(join(root, '.gitignore'), 'remote.git/\n');
  git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
  git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'develop');
});
afterEach(() => { ghHandler.fn = null; vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
async function input() {
  const base = await resolvePrForkBase(repo, 'develop');
  git('checkout', '-qb', 'cez/task');
  writeFileSync(join(root, 'task.txt'), 'task work');
  return { repoRoot: repo, handoffText: '# Goal\nship it', retryDelayMs: 0, run: {
    title: 'fix', task: 'fix', branch: 'cez/task', worktreePath: repo,
    baseBranch: base.sha, prForkBase: base,
  } as RunRecord };
}
it('publishes to the persisted develop target even when baseBranch is a SHA', async () => {
  const payload = await input();
  expect((await createDraftPr(payload)).ok).toBe(true);
  expect(ghCalls[0]).toEqual(expect.arrayContaining(['--base', 'develop', '--head', 'cez/task']));
  expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/cez/task')).toBe(git('rev-parse', 'HEAD'));
});
it('opens a draft by default and a ready-for-review PR when asked', async () => {
  const payload = await input();
  expect((await createDraftPr(payload)).ok).toBe(true);
  expect(ghCalls[0]).toContain('--draft');
  ghCalls.length = 0;
  expect((await createDraftPr({ ...payload, draft: false })).ok).toBe(true);
  expect(ghCalls[0]?.slice(0, 2)).toEqual(['pr', 'create']);
  expect(ghCalls[0]).not.toContain('--draft');
});
it('changed origin blocks publication before autosave, push or gh', async () => {
  const payload = await input(); const before = git('rev-parse', 'HEAD');
  git('remote', 'set-url', 'origin', `${remote}-changed`);
  const outcome = await createDraftPr(payload);
  expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('origin URL changed') });
  expect(git('rev-parse', 'HEAD')).toBe(before); expect(ghCalls).toEqual([]);
  expect(() => git('--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/cez/task')).toThrow();
});

it('wrong HEAD blocks publication before autosave, push or gh and preserves task changes', async () => {
  const payload = await input(); const before = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'develop');
  const outcome = await createDraftPr(payload);
  expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('HEAD is not the task branch') });
  expect(git('rev-parse', 'HEAD')).toBe(before);
  expect(git('rev-parse', 'refs/heads/cez/task')).toBe(before);
  expect(git('status', '--short')).toContain('task.txt');
  expect(ghCalls).toEqual([]);
  expect(() => git('--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/cez/task')).toThrow();
});

it('retries transient post-push branch propagation errors while preserving draft: false and --base', async () => {
  const payload = await input();
  let createAttempts = 0;
  ghHandler.fn = (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'list') {
      return { err: new Error('no PR yet'), stderr: 'no pull requests found for branch "cez/task"' };
    }
    createAttempts++;
    if (createAttempts === 1) {
      return { err: new Error('exit 1'), stderr: 'GraphQL: No commits between develop and cez/task (createPullRequest)' };
    }
    if (createAttempts === 2) {
      return { err: new Error('exit 1'), stderr: "GraphQL: Head sha can't be blank, Base sha can't be blank (createPullRequest)" };
    }
    return { stdout: 'https://github.com/test/repo/pull/9\n' };
  };
  const outcome = await createDraftPr({ ...payload, draft: false });
  expect(outcome).toEqual({ ok: true, url: 'https://github.com/test/repo/pull/9', dryRun: false });
  expect(createAttempts).toBe(3);
  const creates = ghCalls.filter((c) => c[0] === 'pr' && c[1] === 'create');
  expect(creates).toHaveLength(3);
  for (const call of creates) {
    expect(call).toEqual(expect.arrayContaining(['--base', 'develop', '--head', 'cez/task']));
    expect(call).not.toContain('--draft');
  }
});

it('reuses an already-created PR instead of duplicating when gh pr create fails or reports already exists', async () => {
  const payload = await input();
  let createAttempts = 0;
  ghHandler.fn = (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'list') {
      return { stdout: JSON.stringify([{ url: 'https://github.com/test/repo/pull/9', headRepositoryOwner: null }]) };
    }
    createAttempts++;
    return { err: new Error('exit 1'), stderr: "GraphQL: Head sha can't be blank" };
  };
  const outcome = await createDraftPr({ ...payload, draft: false });
  expect(outcome).toEqual({ ok: true, url: 'https://github.com/test/repo/pull/9', dryRun: false });
  expect(createAttempts).toBe(1);
});

it('does not retry authentication or permission errors', async () => {
  const payload = await input();
  let createAttempts = 0;
  ghHandler.fn = (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'list') return { stdout: '[]' };
    createAttempts++;
    return { err: new Error('exit 1'), stderr: 'HTTP 403: Resource not accessible by integration (createPullRequest)' };
  };
  const permOutcome = await createDraftPr(payload);
  expect(permOutcome.ok).toBe(false);
  expect(createAttempts).toBe(1);
});

it('does not retry No commits between when the branch genuinely has zero commits ahead of base', async () => {
  const payload = await input();
  // Remove the untracked file BEFORE createDraftPr runs so pre-PR autosave has nothing to commit.
  rmSync(join(root, 'task.txt'));
  let createAttempts = 0;
  ghHandler.fn = (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'list') {
      return { err: new Error('none'), stderr: 'no pull requests found' };
    }
    createAttempts++;
    return { err: new Error('exit 1'), stderr: 'GraphQL: No commits between develop and cez/task (createPullRequest)' };
  };
  const emptyOutcome = await createDraftPr(payload);
  expect(emptyOutcome.ok).toBe(false);
  expect(createAttempts).toBe(1);
});

// Fork-local guard over upstream #1383: on a downstream fork whose `upstream` remote is the fork
// parent and `gh repo set-default` marked it `gh-resolved base` (this very repository's setup),
// upstream's detection picks `upstream` — a run pinned to `origin` must still open its PR there.
it('a pinned run targets origin even when another remote is the gh-resolved fork parent', async () => {
  git('remote', 'add', 'upstream', 'https://github.com/up/project.git');
  git('config', 'remote.upstream.gh-resolved', 'base');
  const remotes = await taskRemotes(repo);
  expect(remotes.base).toBe('upstream');
  expect(remotes.push).toBe('origin');
  const pinned = await resolvePrForkBase(repo, 'develop');
  expect(prTargetRemote({ prForkBase: pinned }, remotes.base!)).toBe('origin');
  expect(prTargetRemote({}, remotes.base!)).toBe('upstream');
});
