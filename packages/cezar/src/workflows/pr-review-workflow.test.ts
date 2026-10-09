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
import type { WorkflowDef } from './types.ts';

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
});
