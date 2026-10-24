import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkReviewText,
  preflightReviewText,
  prReviewMarker,
  publishReviewFromRun,
  type CommandRunner,
  type PrReviewTarget,
} from '../automations/pr-review.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { writeNodeText } from './node-text.ts';
import { RunManager } from './run.ts';
import { PR_REVIEW } from './templates.ts';
import type { WorkflowDef } from './types.ts';

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'c'.repeat(40);
const TARGET: PrReviewTarget = { repo: 'metelskiwiktor/cezar', number: 19, headSha: HEAD, baseRef: 'origin/main', mergeBase: 'b'.repeat(40) };

/** A review shaped like #19: full assessment, coverage, Recommendation, and an inline /bin/sh in prose. */
const FILLER = Array.from({ length: 120 }, (_, i) => `- Checked case ${i}: behaviour matches the documented contract for this path.`).join('\n');
const REVIEW_19 = [
  '## Review of the Windows test changes',
  '',
  FILLER,
  '',
  '### Limitations',
  '- The new test cannot cover inline `/bin/sh` launcher execution on Windows runners.',
  '',
  'Coverage: all changed files were read; `npm run typecheck` exited 0.',
  'Recommendation: APPROVE',
].join('\n');

function fakeGh(state: { remoteHead: string; comments: string[] }) {
  const posts: string[] = [];
  const run: CommandRunner = async (exe, args) => {
    if (exe !== 'gh') throw new Error(`unexpected ${exe}`);
    if (args[1] === `repos/${TARGET.repo}/pulls/${TARGET.number}`) return `${state.remoteHead}\n`;
    if (args[1] === '--paginate') return state.comments.join('\n');
    if (args[1] === '--method' && args[3] === `repos/${TARGET.repo}/issues/${TARGET.number}/comments`) {
      const { body } = JSON.parse(readFileSync(args[5] as string, 'utf8')) as { body: string };
      posts.push(body);
      state.comments.push(body);
      return '{}';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, posts, state };
}

describe('preflightReviewText: /bin/sh in descriptive prose', () => {
  const wrap = (line: string) => `Assessment of the change and its tests, with details.\n${line}\n\nRecommendation: APPROVE`;

  it('rewrites the exact inline literal (plain and as a lone code span) and revalidates the whole body', () => {
    for (const line of ['It cannot exercise inline /bin/sh launcher execution.', 'It cannot exercise inline `/bin/sh` launcher execution.']) {
      const out = preflightReviewText(wrap(line));
      expect(out.repaired).toBe(true);
      expect(out.text).toContain('inline POSIX shell launcher execution');
      expect(out.text).not.toContain('/bin/sh');
      expect(checkReviewText(out.text).ok).toBe(true);
    }
  });

  it.each([
    ['a finding location', '- [P1] Location: /bin/sh:3 launcher is wrong'],
    ['a command snippet', 'Run `/bin/sh -c "echo hi"` to see it.'],
    ['an unquoted command', 'Run /bin/sh -c "echo hi" to see it.'],
    ['a command with a script argument', 'Run /bin/sh scripts/check.sh to reproduce.'],
    ['a code-span command with arguments outside the span', 'Run `/bin/sh` -c "echo ok" to reproduce.'],
    ['a code-span command with a script argument', 'Run `/bin/sh` scripts/check.sh to reproduce.'],
    ['another verb and argument', 'Then execute /bin/sh build.sh and compare.'],
    ['a bare mention outside the proven phrase', 'The /bin/sh launcher is slow on this runner.'],
    ['a longer path','The file /bin/sh/extra is odd.'],
    ['a private path', 'It reads C:\\Users\\someone\\secret.txt first.'],
    ['another absolute path', 'It reads /home/someone/secret.txt first.'],
    ['a link', 'See [launcher](/bin/sh) for details.'],
  ])('leaves %s untouched and still rejects it', (_name, line) => {
    const out = preflightReviewText(wrap(line));
    expect(out.repaired).toBe(false);
    expect(out.text).toContain(line);
    expect(checkReviewText(out.text).ok).toBe(false);
  });

  it.each([
    'Assessment: inspect the shell launcher behaviour.\nRun /bin/sh scripts/check.sh to reproduce.\nRecommendation: APPROVE',
    'Assessment: inspect the shell launcher behaviour.\nRun `/bin/sh` -c "echo ok" to reproduce.\nRecommendation: APPROVE',
  ])('does not mutate a command or change the verdict (%#)', (text) => {
    const out = preflightReviewText(text);
    expect(out.repaired).toBe(false);
    expect(out.text).toBe(text);
    expect(checkReviewText(out.text).ok).toBe(false);
  });

  it('only rewrites the phrase and keeps findings and verdict byte-identical', () => {
    const text = 'Assessment of the tests, with enough detail.\n- [P2] tests/a.ts:3 — weak assertion\nIt cannot cover inline /bin/sh launcher execution here.\nRecommendation: CHANGES REQUESTED';
    const out = preflightReviewText(text);
    expect(out.text).toBe(text.replace('/bin/sh', 'POSIX shell'));
  });

  it('never edits a fenced code block', () => {
    const out = preflightReviewText(wrap('```sh\n/bin/sh run.sh\n```'));
    expect(out.repaired).toBe(false);
    expect(checkReviewText(out.text).ok).toBe(false);
  });

  it('keeps a mixed body whole: another path elsewhere still rejects it', () => {
    const out = preflightReviewText(wrap('inline /bin/sh launcher and /home/x/y.txt'));
    expect(out.repaired).toBe(false);
  });
});

describe('publishReviewFromRun with a #19-shaped review', () => {
  it('corrects the description, reports the repair once and posts the whole review', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    let repairs = 0;
    const res = await publishReviewFromRun({ repoRoot: tmpdir(), target: TARGET, text: REVIEW_19, run: gh.run, onFormatRepair: () => repairs++ });
    expect(res.status).toBe('published');
    expect(repairs).toBe(1);
    expect(gh.posts).toHaveLength(1);
    expect(gh.posts[0]).toContain('inline POSIX shell launcher execution');
    expect(gh.posts[0]).toContain('Recommendation: APPROVE');
    expect(gh.posts[0]).toContain(prReviewMarker(19, HEAD));
  });

  it('a stale HEAD publishes nothing', async () => {
    const gh = fakeGh({ remoteHead: NEW_HEAD, comments: [] });
    expect((await publishReviewFromRun({ repoRoot: tmpdir(), target: TARGET, text: REVIEW_19, run: gh.run })).status).toBe('stale');
    expect(gh.posts).toEqual([]);
  });

  it('an existing marker for repo+PR+HEAD is a duplicate', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [prReviewMarker(19, HEAD)] });
    expect((await publishReviewFromRun({ repoRoot: tmpdir(), target: TARGET, text: REVIEW_19, run: gh.run })).status).toBe('skipped-duplicate');
    expect(gh.posts).toEqual([]);
  });
});

/** Recovery: re-post the SAVED result of a finished analysis, never rerunning the agent. */
describe('republishReview (mock agent, fake gh)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-pr-republish-'));
    dataDir = join(repoRoot, '.ai/cezar');
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(dataDir);
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
      // Windows: an exiting agent process can hold its cwd a moment longer.
    }
  });

  const terminal = (r: RunRecord) => ['done', 'review', 'failed', 'cancelled'].includes(r.status);
  async function until(id: string, pred: (r: RunRecord) => boolean): Promise<RunRecord> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = store.getRun(id);
      if (r && pred(r)) return r;
      if (Date.now() > deadline) throw new Error(`timed out; status=${r?.status}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  function startReview(gh: ReturnType<typeof fakeGh>, task: string, withTarget = true): string {
    manager = new RunManager(store, repoRoot, { prReviewCommandRunner: gh.run });
    return manager.startRun(PR_REVIEW as WorkflowDef, { task, worktree: false, readOnly: true, ...(withTarget ? { prReview: TARGET } : {}) }).id;
  }

  /** Runs the mock review to the end, then rewinds the publish node to "blocked" with `text` saved. */
  async function blockedRun(gh: ReturnType<typeof fakeGh>, text: string): Promise<string> {
    const id = startReview(gh, 'review it mock:review=100');
    await until(id, terminal);
    writeNodeText(dataDir, id, 'review', text);
    const run = store.getRun(id) as RunRecord;
    store.updateRun(id, {
      graphState: {
        ...(run.graphState ?? { loops: {}, taken: [] }),
        outputs: { ...run.graphState?.outputs, publish: { status: 'invalid', reason: 'the review contains a local path; use plain repo-relative path:line' } },
      },
    });
    gh.state.comments.length = 0;
    gh.posts.length = 0;
    return id;
  }

  const agentEvents = (id: string) => store.readEvents(id).filter((e) => e.type !== 'note').length;

  it('reports analysis and publication separately, then republishes the saved full text without the agent', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = await blockedRun(gh, REVIEW_19);
    expect(REVIEW_19.length).toBeGreaterThan(4000);
    expect(manager?.reviewPublication(id)).toMatchObject({ analysis: 'complete', publication: 'blocked', canRepublish: true });
    const before = { events: agentEvents(id), steps: JSON.stringify(store.getRun(id)?.steps), runs: store.listRuns().length };

    const res = await manager!.republishReview(id);
    expect(res).toMatchObject({ ok: true, state: { analysis: 'complete', publication: 'published', canRepublish: false } });
    expect(gh.posts).toHaveLength(1);
    expect(gh.posts[0]!.length).toBeGreaterThan(4000); // the saved full text, not the graph summary tail
    expect(gh.posts[0]).toContain('## Review of the Windows test changes');
    expect(gh.posts[0]).toContain('inline POSIX shell launcher execution');
    // No agent ran: same steps, same non-note events, no new run.
    expect({ events: agentEvents(id), steps: JSON.stringify(store.getRun(id)?.steps), runs: store.listRuns().length }).toEqual(before);

    // A second call has nothing to republish and posts nothing.
    expect(await manager!.republishReview(id)).toMatchObject({ ok: false });
    expect(gh.posts).toHaveLength(1);
  }, 40_000);

  it('stays blocked, with the reason, when the text is still wrong', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = await blockedRun(gh, REVIEW_19.replace('inline `/bin/sh` launcher', 'the file /home/someone/launcher'));
    expect(await manager!.republishReview(id)).toMatchObject({ ok: true, state: { publication: 'blocked', canRepublish: true } });
    expect(manager?.reviewPublication(id)?.reason).toMatch(/local path/);
    expect(gh.posts).toEqual([]);
  }, 40_000);

  it('does not post on a stale HEAD', async () => {
    const gh = fakeGh({ remoteHead: NEW_HEAD, comments: [] });
    const id = await blockedRun(gh, REVIEW_19);
    expect(await manager!.republishReview(id)).toMatchObject({ ok: true, state: { publication: 'stale', canRepublish: false } });
    expect(gh.posts).toEqual([]);
  }, 40_000);

  it('does not post a duplicate when the marker is already on the PR', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = await blockedRun(gh, REVIEW_19);
    gh.state.comments.push(prReviewMarker(19, HEAD));
    expect(await manager!.republishReview(id)).toMatchObject({ ok: true, state: { publication: 'duplicate' } });
    expect(gh.posts).toEqual([]);
  }, 40_000);

  it('refuses an incomplete analysis (the review step failed)', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = startReview(gh, 'review it mock:auth-error');
    await until(id, terminal);
    writeNodeText(dataDir, id, 'review', REVIEW_19);
    expect(manager!.reviewPublication(id)).toMatchObject({ analysis: 'incomplete', canRepublish: false });
    expect(await manager!.republishReview(id)).toMatchObject({ ok: false, error: expect.stringMatching(/did not complete/) });
    expect(gh.posts).toEqual([]);
  }, 40_000);

  it('refuses a run without a PR target', async () => {
    const gh = fakeGh({ remoteHead: HEAD, comments: [] });
    const id = startReview(gh, 'review it mock:review=100', false);
    await until(id, terminal);
    expect(manager!.reviewPublication(id)).toBeUndefined();
    expect(await manager!.republishReview(id)).toMatchObject({ ok: false, error: 'not a PR review run' });
  }, 40_000);
});
