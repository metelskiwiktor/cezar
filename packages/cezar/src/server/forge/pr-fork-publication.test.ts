import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../runs/store.ts';
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ghCalls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: unknown[]) => {
    if (args[0] === 'gh') {
      ghCalls.push(args[1] as string[]);
      const callback = args.at(-1) as (err: null, stdout: string, stderr: string) => void;
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
import { createDraftPr } from './github.ts';

let root: string;
let repo: string;
let remote: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0'); ghCalls.length = 0;
  root = mkdtempSync(join(tmpdir(), 'cez-pr-publish-')); repo = root;
  remote = join(root, 'remote.git');
  git('init', '--bare', '-q', '-b', 'main', remote);
  git('init', '-q', '-b', 'develop');
  writeFileSync(join(root, '.gitignore'), 'remote.git/\n');
  git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
  git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'develop');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
async function input() {
  const base = await resolvePrForkBase(repo, 'develop');
  git('checkout', '-qb', 'cez/task');
  writeFileSync(join(root, 'task.txt'), 'task work');
  return { repoRoot: repo, handoffText: '# Goal\nship it', run: {
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
it('changed origin blocks publication before autosave, push or gh', async () => {
  const payload = await input(); const before = git('rev-parse', 'HEAD');
  git('remote', 'set-url', 'origin', `${remote}-changed`);
  const outcome = await createDraftPr(payload);
  expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('origin URL changed') });
  expect(git('rev-parse', 'HEAD')).toBe(before); expect(ghCalls).toEqual([]);
  expect(() => git('--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/cez/task')).toThrow();
});
