import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr } from '../server/forge/github.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import { producesPullRequest } from '../pr-fork.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { graphIssues, type WorkflowGraph } from './graph.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';
import { ANALYSIS, IMPLEMENT, IMPLEMENT_AND_VERIFY, PR_REVIEW } from './templates.ts';
import { QUICK_TASK_WORKFLOW, isReadOnlyWorkflow } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** The three lightweight workflows: implement, analysis, pr-review. */
describe('lightweight workflow definitions', () => {
  it('all three are built-ins loadWorkflows finds by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-light-load-'));
    try {
      const names = (await loadWorkflows(root)).workflows.map((w) => w.name);
      expect(names).toEqual(['analysis', 'implement', 'pr-review', 'quick-task']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('implement is one agent session, then a ready-for-review PR — no gates, loops or extra reviews', () => {
    const graph = IMPLEMENT.graph as WorkflowGraph;
    expect(graphIssues(graph)).toEqual([]);
    expect(IMPLEMENT.steps.map((s) => s.id)).toEqual(['implement']);
    expect(graph.nodes.map((n) => n.type).sort()).toEqual(['agent', 'end', 'github.draft-pr', 'start']);
    expect(graph.nodes.find((n) => n.type === 'github.draft-pr')).toMatchObject({ ready: true });
    // A PR-producing graph: cezar pins a fresh remote base before the worktree exists.
    expect(producesPullRequest(IMPLEMENT)).toBe(true);
    expect(isReadOnlyWorkflow(IMPLEMENT)).toBe(false);
  });

  it('analysis is read-only end to end and never produces a PR', () => {
    expect(isReadOnlyWorkflow(ANALYSIS)).toBe(true);
    expect(producesPullRequest(ANALYSIS)).toBe(false);
    expect(ANALYSIS.steps).toHaveLength(1);
    expect(ANALYSIS.steps[0]?.allowedTools).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
  });

  it('only all-review step workflows are read-only; existing workflows are untouched', () => {
    for (const w of [QUICK_TASK_WORKFLOW, IMPLEMENT_AND_VERIFY, PR_REVIEW]) expect(isReadOnlyWorkflow(w)).toBe(false);
    expect(isReadOnlyWorkflow({ steps: [{ id: 'a', prompt: 'x', review: true }, { id: 'b', prompt: 'y' }] })).toBe(false);
    expect(isReadOnlyWorkflow({ steps: [] })).toBe(false);
    expect(producesPullRequest(IMPLEMENT_AND_VERIFY)).toBe(false);
  });
});

/** Real RunManager + the bundled mock agent (`CEZ_DRY_RUN=1`): no network, no real PR. */
describe('lightweight workflow runs (mock agent)', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cez-light-run-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const repo = join(root, 'repo');
    git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, repo);
    writeFileSync(join(repo, '.gitignore'), '.ai/\n');
    writeFileSync(join(repo, 'base.txt'), 'base');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const manager = new RunManager(store, repo);
    managers.push(manager);
    return { repo, store, manager, base: git(repo, 'rev-parse', 'HEAD') };
  }

  async function settle(store: RunStore, id: string): Promise<RunRecord> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const record = store.getRun(id)!;
      if (['done', 'review', 'failed', 'waiting'].includes(record.status) && !managers.some((m) => m.isActive(id))) return record;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('did not settle');
  }

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    // Relative: the mock agent appends its argv to this file in ITS cwd — the task worktree —
    // which gives every run a real file the agent "left behind".
    vi.stubEnv('CEZ_MOCK_ARGS_FILE', 'mock-args.ndjson');
  });
  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const store of stores.splice(0)) store.flush();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  it('implement: one agent session, then cezar opens the PR ready for review', async () => {
    const { store, manager } = fixture();
    const final = await settle(store, manager.startRun(IMPLEMENT, { task: 'add a feature mock:done' }).id);
    expect(final.status).toBe('done');
    expect(final.pullRequestUrl).toMatch(/\/pull\/\d+$/);
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([['implement', 'done'], ['pr', 'done']]);
    const notes = store.readEvents(final.id).flatMap((e) => (e.type === 'note' && 'message' in e ? [String(e.message)] : []));
    expect(notes.some((m) => m.startsWith('ready-for-review PR opened'))).toBe(true);
    expect(notes.some((m) => /draft PR/.test(m))).toBe(false);
  });

  it('analysis: read-only run — read tools only, nothing committed, never enters review gate, no PR', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    const { store, manager, base, repo } = fixture();
    const final = await settle(store, manager.startRun(ANALYSIS, { task: 'why is X slow? mock:done' }).id);
    expect(final.status).toBe('done');
    expect(final.readOnly).toBe(true);
    expect(final.pullRequestUrl).toBeUndefined();
    const worktree = final.worktreePath as string;
    const argsFile = join(worktree, 'mock-args.ndjson');
    expect(existsSync(argsFile)).toBe(true);
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0] as string) as string[];
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob,WebFetch,WebSearch');
    // The file the agent left is NOT autosave-committed and NOT staged via git add -N:
    // the branch still sits on the base and untracked files remain `??`, never intent-to-add (` A`).
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    const statusLines = git(worktree, 'status', '--porcelain').split('\n');
    expect(statusLines).toContain('?? mock-args.ndjson');
    expect(statusLines.every((l) => l.startsWith('?? '))).toBe(true);
    // Direct PR creation and the public HTTP endpoint are both refused for read-only runs.
    await expect(createDraftPr({ repoRoot: repo, run: final, handoffText: '' })).resolves.toEqual({
      ok: false,
      error: 'read-only runs cannot open a pull request',
    });
    const app = createApp({ store, manager, repoRoot: repo, version: '0.0.0-test' });
    const res = await apiRequest(app, `/api/v1/runs/${final.id}/pr`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'read-only runs cannot open a pull request' });
    expect(store.getRun(final.id)?.pullRequestUrl).toBeUndefined();
  });

  it('guard: an ordinary task still autosave-commits what the agent left', async () => {
    const { store, manager, base } = fixture();
    const final = await settle(store, manager.startRun(QUICK_TASK_WORKFLOW, { task: 'tweak mock:done' }).id);
    expect(final.readOnly).not.toBe(true);
    expect(git(final.worktreePath as string, 'rev-parse', 'HEAD')).not.toBe(base);
  });
});
