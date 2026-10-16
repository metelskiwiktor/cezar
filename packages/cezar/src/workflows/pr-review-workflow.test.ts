import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prReviewMarker, type CommandRunner, type PrReviewTarget } from '../automations/pr-review.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { graphIssues, NODE_CATALOG, type WorkflowGraph } from './graph.ts';
import { loadWorkflows } from './load.ts';
import { readNodeText } from './node-text.ts';
import { RunManager } from './run.ts';
import { PR_REVIEW } from './templates.ts';
import { reviewsPullRequest, type WorkflowDef } from './types.ts';

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const TARGET: PrReviewTarget = { repo: 'metelskiwiktor/tabnote', number: 25, headSha: HEAD, baseRef: 'origin/main', mergeBase: 'b'.repeat(40) };

/** A fake `gh`: the PR's remote head, its existing comments, and every POST it receives. */
function fakeGh(state: { remoteHead: string; comments: string[] }): { run: CommandRunner; posts: string[]; calls: string[] } {
  const posts: string[] = [];
  const calls: string[] = [];
  const run: CommandRunner = async (exe, args) => {
    calls.push(`${exe} ${args.join(' ')}`.slice(0, 120));
    if (exe !== 'gh') throw new Error(`unexpected ${exe}`);
    if (args[1] === `repos/${TARGET.repo}/pulls/${TARGET.number}`) return `${state.remoteHead}\n`;
    if (args[1] === '--paginate') return state.comments.join('\n');
    if (args[1] === '--method' && args[2] === 'POST' && args[3] === `repos/${TARGET.repo}/issues/${TARGET.number}/comments` && args[4] === '--input') {
      const { body } = JSON.parse(readFileSync(args[5] as string, 'utf8')) as { body: string };
      posts.push(body);
      state.comments.push(body);
      return '{}';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, posts, calls };
}

describe('pr-review workflow definition', () => {
  it('is a sound built-in graph that loadWorkflows finds by name', async () => {
    expect(graphIssues(PR_REVIEW.graph as WorkflowGraph)).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), 'cez-pr-review-load-'));
    try {
      const { workflows } = await loadWorkflows(root);
      const found = workflows.find((w) => w.name === 'pr-review');
      expect(found?.graph?.nodes.map((n) => n.type)).toContain('github.review-comment');
      // Only the review agent is an agent step; the publication is cezar's own node.
      expect(found?.steps.map((s) => s.id)).toEqual(['review']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the node is in the catalog and must name an agent node', () => {
    expect(NODE_CATALOG.find((c) => c.type === 'github.review-comment')?.ports).toEqual(['published', 'duplicate', 'stale', 'failed']);
    const bad: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'tests', type: 'check', command: 'true' },
        { id: 'publish', type: 'github.review-comment', from: 'tests' },
      ],
      edges: [
        { from: 'start', to: 'tests' },
        { from: 'tests.pass', to: 'publish' },
      ],
    };
    expect(graphIssues(bad).join('\n')).toMatch(/review comment node "publish" must publish an agent node's text/);
  });
});

/**
 * The whole workflow on a real RunManager with the bundled mock agent (`CEZ_DRY_RUN=1`) and a
 * fake `gh` behind the node's command-runner seam: no network, no real comment.
 */
describe('pr-review workflow run (mock agent, fake gh)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-review-run-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    try {
      rmSync(repoRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows: an exiting agent process can hold its cwd a moment longer — a leftover temp dir.
    }
  });

  const terminal = (r: RunRecord) => ['done', 'review', 'failed', 'cancelled'].includes(r.status);
  async function until(id: string, pred: (r: RunRecord) => boolean, ms = 20_000): Promise<RunRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = store.getRun(id);
      if (r && pred(r)) return r;
      if (Date.now() > deadline) throw new Error(`timed out; status=${r?.status} steps=${JSON.stringify(r?.steps.map((s) => [s.id, s.status]))}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  function start(gh: CommandRunner, task: string, extra: { prReview?: PrReviewTarget | undefined; model?: string } = { prReview: TARGET }): string {
    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: gh });
    return manager.startRun(PR_REVIEW as WorkflowDef, { task, worktree: false, readOnly: true, ...extra }).id;
  }

  it('publishes the FULL review (> 4000 chars) once, with the model the step ran and the PR+HEAD marker', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = start(gh.run, 'review it mock:review=6000', { prReview: TARGET, model: 'haiku' });
    const final = await until(id, terminal);
    expect(final.error).toBeUndefined();
    expect(final.status).not.toBe('failed');
    expect(final.steps.map((s) => [s.id, s.status])).toEqual([['review', 'done'], ['publish', 'done']]);
    expect(gh.posts).toHaveLength(1);
    const body = gh.posts[0] as string;
    expect(body.length).toBeGreaterThan(6000);
    expect(body).toContain('REVIEW-START'); // the head of the text survives (a 4000-char tail would drop it)
    expect(body).toContain('Recommendation: CHANGES REQUESTED');
    expect(body).toContain(prReviewMarker(25, HEAD));
    const header = body.split('\n')[0] as string;
    expect(header).toContain(final.modelIdentity ?? '__missing__');
    expect(header).toContain('haiku');
    expect(final.graphState?.outputs?.publish).toMatchObject({ status: 'published', headSha: HEAD });
    expect(readNodeText(join(repoRoot, '.ai/cezar'), id, 'review')?.length).toBeGreaterThan(6000);
  }, 30_000);

  it('a failed review step publishes nothing and the run fails', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = start(gh.run, 'review it mock:auth-error');
    const final = await until(id, terminal);
    expect(final.status).toBe('failed');
    expect(gh.calls).toEqual([]);
    expect(final.steps.find((s) => s.id === 'publish')?.status).toBe('pending');
  }, 30_000);

  it('a review without a Recommendation line is not published and the run fails', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = start(gh.run, 'review it mock:review-bad');
    const final = await until(id, terminal);
    expect(final.status).toBe('failed');
    expect(gh.posts).toEqual([]);
  }, 30_000);

  it('a PR HEAD that moved during the review → review-stale, nothing published, run failed', async () => {
    const gh = fakeGh({ remoteHead: NEW_HEAD, comments: [] });
    const id = start(gh.run, 'review it mock:review=500');
    const final = await until(id, terminal);
    expect(final.status).toBe('failed');
    expect(final.error ?? '').toMatch(/review-stale/);
    expect(gh.posts).toEqual([]);
    expect(final.graphState?.outputs?.publish).toMatchObject({ status: 'stale' });
  }, 30_000);

  it('the same PR+HEAD already reviewed → skipped (success); a new HEAD gets its own review', async () => {
    const dup = fakeGh({ remoteHead: HEAD, comments: [`old\n\n${prReviewMarker(25, HEAD)}`] });
    const a = start(dup.run, 'review it mock:review=500');
    const first = await until(a, terminal);
    expect(first.status).not.toBe('failed');
    expect(dup.posts).toEqual([]);
    expect(first.graphState?.outputs?.publish).toMatchObject({ status: 'duplicate' });
    manager?.dispose();

    const fresh = fakeGh({ remoteHead: NEW_HEAD, comments: [`old\n\n${prReviewMarker(25, HEAD)}`] });
    const b = start(fresh.run, 'review it mock:review=500', { prReview: { ...TARGET, headSha: NEW_HEAD } });
    await until(b, terminal);
    expect(fresh.posts).toHaveLength(1);
    expect(fresh.posts[0]).toContain(prReviewMarker(25, NEW_HEAD));
  }, 40_000);

  it('a run with no or a malformed PR target fails without calling GitHub', async () => {
    const none = fakeGh({ remoteHead: HEAD, comments: [] });
    const a = start(none.run, 'review it mock:review=500', { prReview: undefined });
    expect((await until(a, terminal)).status).toBe('failed');
    expect(none.calls).toEqual([]);
    manager?.dispose();

    const bad = fakeGh({ remoteHead: HEAD, comments: [] });
    const b = start(bad.run, 'review it mock:review=500', { prReview: { ...TARGET, repo: 'not a repo' } });
    expect((await until(b, terminal)).status).toBe('failed');
    expect(bad.calls).toEqual([]);
  }, 40_000);

  it('resuming at the publish node after a restart does not publish a second time', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = start(gh.run, 'review it mock:review=500');
    await until(id, terminal);
    expect(gh.posts).toHaveLength(1);
    manager?.dispose();

    // The process died with the walk ON `publish` (right after the POST, before the run settled).
    const rec = store.getRun(id) as RunRecord;
    store.updateRun(id, {
      status: 'running',
      finishedAt: undefined,
      graphState: { loops: rec.graphState?.loops ?? {}, taken: rec.graphState?.taken ?? [], outputs: rec.graphState?.outputs, cursor: 'publish' },
    });
    store.updateStep(id, 'publish', { status: 'running' });
    store.flush();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: gh.run });
    await manager.recover();

    const back = await until(id, terminal);
    expect(back.status).not.toBe('failed');
    expect(back.steps.find((s) => s.id === 'review')?.iterations).toBe(1); // the review is not redone
    expect(gh.posts).toHaveLength(1);
    expect(gh.calls.filter((c) => c.startsWith('gh api --method POST '))).toHaveLength(1);

    // Lost outputs (killed between the POST and persisting it): the PR's own marker still blocks a
    // second post. Not an atomic guarantee — GitHub has no conditional create — but no duplicate here.
    const third = start(gh.run, 'review it mock:review=500');
    await until(third, terminal);
    expect(gh.posts).toHaveLength(1);
    expect(store.getRun(third)?.graphState?.outputs?.publish).toMatchObject({ status: 'duplicate' });
    expect(readFileSync(join(repoRoot, 'a.txt'), 'utf8')).toBe('one\n');
  }, 60_000);

  it('automatically prepares PR checkout when launched with PR number in prompt and forks from PR HEAD', async () => {
    // 1. Create a PR branch with a distinct file to prove the worktree forks from the PR HEAD
    await execFileAsync('git', ['checkout', '-q', '-b', 'pr-42-branch'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'pr-only-file.txt'), 'content of PR 42\n');
    await execFileAsync('git', ['add', 'pr-only-file.txt'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'pr 42 commit'], { cwd: repoRoot });
    const prHeadSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
    const mainHeadSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/metelskiwiktor/tabnote.git'], { cwd: repoRoot });

    const posts: string[] = [];
    const calls: string[] = [];
    const mockRunner: CommandRunner = async (exe, args) => {
      calls.push(`${exe} ${args.join(' ')}`);
      if (exe === 'gh') {
        if (args[0] === 'pr' && args[1] === 'view' && args[2] === '42') {
          return JSON.stringify({ baseRefName: 'main' });
        }
        if (args[1] === `repos/metelskiwiktor/tabnote/pulls/42`) return `${prHeadSha}\n`;
        if (args[1] === '--paginate') return '';
        if (args[1] === '--method' && args[2] === 'POST' && args[3] === `repos/metelskiwiktor/tabnote/issues/42/comments`) {
          const { body } = JSON.parse(readFileSync(args[5] as string, 'utf8')) as { body: string };
          posts.push(body);
          return '{}';
        }
      }
      if (exe === 'git') {
        if (args[0] === 'fetch') {
          await execFileAsync('git', ['update-ref', 'refs/cez/pr/42/head', prHeadSha], { cwd: repoRoot });
          await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', mainHeadSha], { cwd: repoRoot });
          return '';
        }
        const res = await execFileAsync('git', [...args], { cwd: repoRoot });
        return res.stdout;
      }
      throw new Error(`unexpected command ${exe} ${args.join(' ')}`);
    };

    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: mockRunner });
    // Start run without explicit prReview: Cezar must extract #42 from the task prompt and prepare the checkout!
    const id = manager.startRun(PR_REVIEW, {
      task: 'Review pull request #42 mock:review=500 in this repository',
    }).id;

    // Verify initial state: readOnly is forced true, prNumber is 42
    const initial = store.getRun(id)!;
    expect(initial.readOnly).toBe(true);
    expect(initial.prNumber).toBe(42);

    const final = await until(id, terminal);
    expect(final.status).not.toBe('failed');
    expect(final.readOnly).toBe(true);
    expect(final.prReview).toEqual({
      repo: 'metelskiwiktor/tabnote',
      number: 42,
      headSha: prHeadSha,
      baseRef: 'origin/main',
      mergeBase: mainHeadSha,
    });
    expect(final.baseBranch).toBe(prHeadSha);
    expect(final.task).toContain('PR review checkout (prepared by cezar)');
    expect(final.task).toContain(`The PR diff is: git diff ${mainHeadSha} ${prHeadSha}`);

    // Verify the created worktree actually has the PR files!
    expect(final.worktreePath).toBeDefined();
    expect(readFileSync(join(final.worktreePath!, 'pr-only-file.txt'), 'utf8').trim()).toBe('content of PR 42');

    // Verify GitHub comment was published with the right marker
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(prReviewMarker(42, prHeadSha));
  }, 60_000);

  it('automatically prepares PR checkout when launched with prNumber input parameter', async () => {
    await execFileAsync('git', ['checkout', '-q', '-b', 'pr-55-branch'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'pr-55-file.txt'), 'content of PR 55\n');
    await execFileAsync('git', ['add', 'pr-55-file.txt'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'pr 55 commit'], { cwd: repoRoot });
    const prHeadSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
    const mainHeadSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    if (!(await execFileAsync('git', ['remote'], { cwd: repoRoot })).stdout.includes('origin')) {
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/metelskiwiktor/tabnote.git'], { cwd: repoRoot });
    }

    const posts: string[] = [];
    const mockRunner: CommandRunner = async (exe, args) => {
      if (exe === 'gh') {
        if (args[0] === 'pr' && args[1] === 'view' && args[2] === '55') {
          return JSON.stringify({ baseRefName: 'main' });
        }
        if (args[1] === `repos/metelskiwiktor/tabnote/pulls/55`) return `${prHeadSha}\n`;
        if (args[1] === '--paginate') return '';
        if (args[1] === '--method' && args[2] === 'POST') {
          const { body } = JSON.parse(readFileSync(args[5] as string, 'utf8')) as { body: string };
          posts.push(body);
          return '{}';
        }
      }
      if (exe === 'git') {
        if (args[0] === 'fetch') {
          await execFileAsync('git', ['update-ref', 'refs/cez/pr/55/head', prHeadSha], { cwd: repoRoot });
          await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', mainHeadSha], { cwd: repoRoot });
          return '';
        }
        const res = await execFileAsync('git', [...args], { cwd: repoRoot });
        return res.stdout;
      }
      throw new Error(`unexpected command ${exe} ${args.join(' ')}`);
    };

    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: mockRunner });
    // Start with prompt that doesn't name #55, but prNumber: 55 is provided
    const id = manager.startRun(PR_REVIEW, {
      task: 'Review the changes thoroughly mock:review=500',
      prNumber: 55,
    }).id;

    const final = await until(id, terminal);
    expect(final.status).not.toBe('failed');
    expect(final.prReview?.number).toBe(55);
    expect(final.prReview?.headSha).toBe(prHeadSha);
    expect(readFileSync(join(final.worktreePath!, 'pr-55-file.txt'), 'utf8').trim()).toBe('content of PR 55');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(prReviewMarker(55, prHeadSha));
  }, 60_000);

  it('fails cleanly without calling GitHub if no PR number can be identified', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: gh.run });
    const id = manager.startRun(PR_REVIEW, {
      task: 'Please review these changes',
    }).id;

    const final = await until(id, terminal);
    expect(final.status).toBe('failed');
    expect(final.error).toContain('PR review pre-flight failed: no pull request number identified for review');
    expect(gh.calls).toEqual([]);
  }, 30_000);

  it('ignores worktree: false and forces isolated worktree and readOnly for pr-review', async () => {
    manager = new RunManager(store, repoRoot);
    const run = manager.startRun(PR_REVIEW, {
      task: 'Review PR #99',
      worktree: false,
    });
    expect(run.readOnly).toBe(true);
    expect(run.worktree).toBeUndefined(); // Opt-out overridden
  });
});
