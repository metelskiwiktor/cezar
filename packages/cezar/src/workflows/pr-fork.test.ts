import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import type { WorkflowDef } from './types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createWorktree } from '../git-worktree.ts';
import { validatePrFork } from '../pr-fork.ts';

const failedIndexes = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (failedIndexes.has(String(args[1]))) throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' });
    return actual.renameSync(...args);
  } };
});

vi.mock('../git-worktree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return { ...actual, createWorktree: vi.fn(actual.createWorktree) };
});

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const managers: RunManager[] = [];
const stores: RunStore[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
function fixture(semaphore?: WorkspaceSemaphore) {
  const root = mkdtempSync(join(tmpdir(), 'cez-pr-fork-')); roots.push(root);
  const remote = join(root, 'remote.git'); const repo = join(root, 'repo');
  git(root, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, repo);
  writeFileSync(join(repo, '.gitignore'), '.ai/\n');
  writeFileSync(join(repo, 'base.txt'), 'base');
  const sha = commit(repo, 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const store = RunStore.open(join(repo, '.ai/cezar'));
  stores.push(store);
  const manager = new RunManager(store, repo, { semaphore }); managers.push(manager);
  return { root, repo, remote, sha, store, manager };
}
const graph: WorkflowGraph = {
  nodes: [{ id: 'start', type: 'start' }, { id: 'check', type: 'check', command: 'echo ran > ran.txt' },
    { id: 'pr', type: 'github.draft-pr' }, { id: 'end', type: 'end', status: 'success' }],
  edges: [{ from: 'start', to: 'check' }, { from: 'check.pass', to: 'end' },
    { from: 'check.fail', to: 'pr' }, { from: 'pr.created', to: 'end' }, { from: 'pr.failed', to: 'end' }],
};
const workflow: WorkflowDef = { name: 'pr-intent', source: 'file', graph, steps: graphToSteps(graph) };
async function settle(store: RunStore, id: string): Promise<RunRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = store.getRun(id)!;
    if (['done', 'review', 'failed'].includes(record.status) && !managers.some((m) => m.isActive(id))) return record;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('did not settle');
}
beforeEach(() => vi.stubEnv('CEZ_DRY_RUN', '1'));
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const store of stores.splice(0)) store.flush();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Async retries let pending child-process close handlers release Windows cwd handles.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

it('PR graph forced in-place start forks the remote SHA, excluding unpushed local main', async () => {
  const { repo, sha, store, manager } = fixture();
  writeFileSync(join(repo, 'unrelated.txt'), 'unpushed'); commit(repo, 'local-only');
  const id = manager.startRun(workflow, { task: 'fix', worktree: false, autonomous: true }).id;
  const record = await settle(store, id);
  expect(record.status, record.error).not.toBe('failed');
  expect(record.worktreePath).toBeDefined();
  expect(record.baseBranch).toBe(sha);
  expect(git(record.worktreePath!, 'ls-tree', '--name-only', 'HEAD')).not.toContain('unrelated.txt');
});

it('missing origin fails pre-flight before any workflow step', async () => {
  const { repo, store, manager } = fixture(); git(repo, 'remote', 'remove', 'origin');
  const record = await settle(store, manager.startRun(workflow, { task: 'fix' }).id);
  expect(record.status).toBe('failed');
  expect(record.error).toContain('PR pre-flight failed');
  expect(record.steps.every((s) => s.status === 'pending')).toBe(true);
});

it('a failed metadata flush stops before fork or workflow execution', async () => {
  const { store, manager } = fixture();
  vi.spyOn(store, 'flush').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  const record = await settle(store, manager.startRun(workflow, { task: 'fix' }).id);
  expect(record.error).toContain('PR pre-flight failed: could not persist pinned base');
  expect(record.worktreePath).toBeUndefined();
  expect(record.steps.every((s) => s.status === 'pending')).toBe(true);
});

it('recovers the durable pre-worktree crash snapshot without repinning an advanced remote', async () => {
  const { repo, remote, sha, store, manager } = fixture();
  writeFileSync(join(repo, 'local-only.txt'), 'never inherit'); commit(repo, 'local-only');
  const index = join(repo, '.ai/cezar/runs.json');
  let snapshot = '';
  vi.mocked(createWorktree).mockImplementationOnce(async (_repo, id, base) => {
    snapshot = readFileSync(index, 'utf8');
    const durable = JSON.parse(snapshot).find((r: RunRecord) => r.id === id);
    expect(durable.prForkBase).toEqual({ sha, targetBranch: 'main', remoteUrl: remote });
    expect(durable.baseBranch).toBe(base);
    expect(durable.status).toBe('running');
    expect(durable.branch).toBeUndefined();
    expect(durable.worktreePath).toBeUndefined();
    expect(existsSync(join(repo, '.ai/cezar/worktrees', id))).toBe(false);
    expect(() => git(repo, 'rev-parse', '--verify', `refs/heads/cez/${id.slice(0, 8)}`)).toThrow();
    throw new Error('injected failure after durable pin, before worktree creation');
  });
  const captureGraph: WorkflowGraph = { ...graph, nodes: graph.nodes.map((n) => n.id === 'check'
    ? { id: 'check', type: 'check', command: `node -e "require('node:fs').writeFileSync('ran.txt', JSON.stringify({sha:process.env.CEZ_PR_BASE_SHA,target:process.env.CEZ_PR_BASE_BRANCH}))"` }
    : n) };
  const id = manager.startRun({ ...workflow, graph: captureGraph, steps: graphToSteps(captureGraph) }, { task: 'recover' }).id;
  const failed = await settle(store, id);
  expect(failed.error).toContain('injected failure');
  expect(failed.steps.every((s) => s.status === 'pending')).toBe(true);
  manager.dispose(); store.flush();
  // Restore exactly the disk image a killed process leaves at the injected boundary,
  // rather than its subsequent caught-failure record. No hand-authored provenance.
  writeFileSync(index, snapshot);
  git(repo, 'checkout', '-q', '-b', 'upstream', sha);
  writeFileSync(join(repo, 'advanced.txt'), 'later'); const advanced = commit(repo, 'advance');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  const reopened = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true }); stores.push(reopened);
  const recovered = new RunManager(reopened, repo); managers.push(recovered);
  await recovered.recover();
  const record = await settle(reopened, id);
  expect(record.status, record.error).not.toBe('failed');
  expect(record.prForkBase).toEqual({ sha, targetBranch: 'main', remoteUrl: remote });
  expect(record.baseBranch).toBe(sha);
  expect(JSON.parse(readFileSync(join(record.worktreePath!, 'ran.txt'), 'utf8'))).toEqual({ sha, target: 'main' });
  expect(git(record.worktreePath!, 'rev-parse', 'HEAD~1')).toBe(sha);
  expect(git(record.worktreePath!, 'ls-tree', '--name-only', 'HEAD')).not.toMatch(/local-only|advanced/);
  expect(await validatePrFork(record.worktreePath!, record.branch!, record.prForkBase!)).toBe(advanced);
  expect(record.prForkBase?.sha).toBe(sha);
});

it('a retry of an unpersisted in-memory pin must flush again before creating a branch', async () => {
  const { repo, store, manager } = fixture();
  const index = join(repo, '.ai/cezar/runs.json');
  // Fail the atomic rename, including debounced saves, rather than only the
  // explicit flush. The test cannot accidentally persist its pin after 300ms.
  failedIndexes.add(index);
  const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const id = manager.startRun(workflow, { task: 'persist' }).id;
    const failed = await settle(store, id);
    expect(failed.error).toContain('could not persist pinned base');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(existsSync(index)).toBe(false);
    store.updateRun(id, { status: 'queued' });
    await manager.recover();
    const retried = await settle(store, id);
    expect(retried.error).toContain('could not persist pinned base');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(retried.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(existsSync(index)).toBe(false);
    const cold = RunStore.open(join(repo, '.ai/cezar')); stores.push(cold);
    expect(cold.getRun(id)).toBeUndefined();
  } finally {
    failedIndexes.delete(index);
    logging.mockRestore();
  }
});

it.each(['option target', 'invalid git target', 'missing commit', 'blank remote'])('rejects structurally loadable but invalid pinned provenance (%s) before creating a task branch', async (shape) => {
  const { repo, sha, remote, store, manager } = fixture(new WorkspaceSemaphore({ initial: { maxParallel: 0 } }));
  const id = manager.startRun(workflow, { task: 'corrupt' }).id;
  const pinned = { sha, targetBranch: 'main', remoteUrl: remote };
  if (shape === 'option target') pinned.targetBranch = '-main';
  if (shape === 'invalid git target') pinned.targetBranch = 'main..bad';
  if (shape === 'missing commit') pinned.sha = 'f'.repeat(40);
  if (shape === 'blank remote') pinned.remoteUrl = '   ';
  store.updateRun(id, { baseBranch: sha, prForkBase: pinned });
  manager.dispose(); store.flush();
  const reopened = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true }); stores.push(reopened);
  const recovered = new RunManager(reopened, repo); managers.push(recovered);
  await recovered.recover();
  const record = await settle(reopened, id);
  expect(record.error).toContain('invalid pinned PR base');
  expect(createWorktree).not.toHaveBeenCalled();
  expect(record.worktreePath).toBeUndefined();
  expect(record.steps.every((s) => s.status === 'pending')).toBe(true);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
});

it('an unrecorded existing task branch is preserved and rejected if its HEAD differs from the pinned SHA', async () => {
  const { repo, store, manager } = fixture(new WorkspaceSemaphore({ initial: { maxParallel: 0 } }));
  const id = manager.startRun(workflow, { task: 'fix' }).id;
  writeFileSync(join(repo, 'unrelated.txt'), 'local'); const local = commit(repo, 'local');
  const existing = await createWorktree(repo, id, local);
  writeFileSync(join(existing.path, 'dirty.txt'), 'keep');
  manager.dispose(); store.flush();
  const reopened = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true }); stores.push(reopened);
  const recovered = new RunManager(reopened, repo); managers.push(recovered);
  await recovered.recover();
  const record = await settle(reopened, id);
  expect(record.error).toContain('existing task branch does not match the pinned fork SHA');
  expect(git(existing.path, 'rev-parse', 'HEAD')).toBe(local);
  expect(git(existing.path, 'status', '--short')).toContain('dirty.txt');
  expect(record.steps.every((s) => s.status === 'pending')).toBe(true);
}, 30_000);

it('a queued forced PR task survives restart and pins its explicit develop target at dequeue', async () => {
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 } });
  const { repo, store, manager } = fixture(semaphore);
  const id = manager.startRun(workflow, { task: 'queued', worktree: false, baseBranch: 'develop' }).id;
  expect(store.getRun(id)?.status).toBe('queued');
  expect(store.getRun(id)?.prForkBase).toBeUndefined();
  expect(store.getRun(id)?.worktree).toBeUndefined();
  manager.dispose(); store.flush();
  git(repo, 'checkout', '-qb', 'develop'); writeFileSync(join(repo, 'develop.txt'), 'remote develop');
  const sha = commit(repo, 'develop'); git(repo, 'push', '-q', 'origin', 'develop');
  const reopened = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true }); stores.push(reopened);
  const recovered = new RunManager(reopened, repo); managers.push(recovered);
  await recovered.recover();
  const record = await settle(reopened, id);
  expect(record.status, record.error).not.toBe('failed');
  expect(record.prForkBase).toMatchObject({ sha, targetBranch: 'develop' });
  expect(record.baseBranch).toBe(sha);
}, 30_000);

it('a controlled child PR graph keeps the committed parent branch as an explicit exception', async () => {
  const { repo, store, manager } = fixture();
  git(repo, 'checkout', '-qb', 'cez/parent'); writeFileSync(join(repo, 'parent.txt'), 'parent work');
  const sha = commit(repo, 'parent');
  const id = manager.startRun(workflow, { task: 'child', baseBranch: 'cez/parent',
    dispatch: { rootRunId: 'parent', parentRunId: 'parent' } }).id;
  const record = await settle(store, id);
  expect(record.prForkBase).toBeUndefined(); expect(record.baseBranch).toBe('cez/parent');
  expect(git(record.worktreePath!, 'rev-parse', 'HEAD~1')).toBe(sha);
});

it('Continue after reopening the store keeps the pinned SHA and branch even if origin changed', async () => {
  const { repo, sha, store, manager } = fixture();
  const agentGraph: WorkflowGraph = { ...graph,
    nodes: graph.nodes.map((n) => n.id === 'check' ? { id: 'check', type: 'agent', prompt: '{{task}}' } : n),
    edges: graph.edges.map((e) => e.from === 'check.pass' ? { ...e, from: 'check.done' } : e),
  };
  const id = manager.startRun({ ...workflow, graph: agentGraph, steps: graphToSteps(agentGraph) },
    { task: 'mock:done', autonomous: true }).id;
  const before = await settle(store, id);
  expect(before.steps.some((s) => s.sessionId)).toBe(true);
  manager.dispose(); store.flush();
  writeFileSync(join(repo, 'new-remote.txt'), 'later'); commit(repo, 'later'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-url', 'origin', join(repo, 'now-unreachable'));
  const reopened = RunStore.open(join(repo, '.ai/cezar')); stores.push(reopened);
  const resumed = new RunManager(reopened, repo); managers.push(resumed);
  expect(resumed.continueRun(id, { text: 'mock:done' })).toEqual({ ok: true });
  const deadline = Date.now() + 15_000;
  while (reopened.getRun(id)?.steps.find((s) => s.id === 'continue-1')?.status !== 'done' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(reopened.getRun(id)?.steps.find((s) => s.id === 'continue-1')?.status).toBe('done');
  const after = await settle(reopened, id);
  expect(after.prForkBase).toEqual(before.prForkBase);
  expect(after.baseBranch).toBe(sha); expect(after.branch).toBe(before.branch);
  expect(after.worktreePath).toBe(before.worktreePath);
}, 30_000);

it('an explicit sync merges the fresh remote target while keeping the fork SHA immutable', async () => {
  const { repo, sha, store, manager } = fixture();
  const path = repo.replaceAll('\\', '/');
  const syncGraph: WorkflowGraph = {
    nodes: [{ id: 'start', type: 'start' }, { id: 'advance', type: 'check', command:
      `git -C "${path}" -c user.name=test -c user.email=test@local commit --allow-empty -qm upstream && git -C "${path}" push -q origin main` },
    { id: 'sync', type: 'git.sync-base' }, { id: 'end', type: 'end', status: 'success' },
    { id: 'pr', type: 'github.draft-pr' }],
    edges: [{ from: 'start', to: 'advance' }, { from: 'advance.pass', to: 'sync' },
      { from: 'sync.done', to: 'end' }, { from: 'sync.failed', to: 'pr' }, { from: 'pr.created', to: 'end' }],
  };
  const record = await settle(store, manager.startRun({ ...workflow, graph: syncGraph, steps: graphToSteps(syncGraph) }, { task: 'sync' }).id);
  expect(record.steps.find((s) => s.id === 'sync')?.status).toBe('done');
  expect(record.baseBranch).toBe(sha);
  expect(git(record.worktreePath!, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  expect(git(repo, 'rev-parse', 'main')).not.toBe(sha);
});

it('a PR graph git.push node blocks a changed origin before publishing the branch', async () => {
  const { repo, remote, store, manager } = fixture();
  const path = repo.replaceAll('\\', '/');
  const pushGraph: WorkflowGraph = {
    nodes: [{ id: 'start', type: 'start' }, { id: 'change', type: 'check',
      command: `git -C "${path}" remote set-url origin "${path}/missing.git"` },
      { id: 'push', type: 'git.push' }, { id: 'pr', type: 'github.draft-pr' },
      { id: 'blocked', type: 'end', status: 'failed' }, { id: 'end', type: 'end', status: 'success' }],
    edges: [{ from: 'start', to: 'change' }, { from: 'change.pass', to: 'push' },
      { from: 'push.done', to: 'pr' }, { from: 'push.failed', to: 'blocked' }, { from: 'pr.created', to: 'end' }],
  };
  const record = await settle(store, manager.startRun({ ...workflow, graph: pushGraph, steps: graphToSteps(pushGraph) }, { task: 'push' }).id);
  expect(record.status).toBe('failed');
  expect(record.steps.find((s) => s.id === 'push')?.status).toBe('failed');
  expect(store.readEvents(record.id).some((e) => String(e.message).includes('origin URL changed'))).toBe(true);
  expect(() => git(repo, '--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${record.branch}`)).toThrow();
});
