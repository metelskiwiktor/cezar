import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkReviewText,
  preparePrReviewCheckout,
  prReviewMarker,
  publishPrReviewComment,
  publishReviewFromRun,
  renderPrReviewContext,
  type CommandRunner,
} from './pr-review.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

/** Records each call; a `--input <file>` call also records the file's parsed JSON in `posts` (read during the call — the file is gone after). */
function fakeRun(
  responses: Record<string, string>,
  fail?: string,
): { run: CommandRunner; calls: string[]; posts: { body: string }[]; inputFiles: string[] } {
  const calls: string[] = [];
  const posts: { body: string }[] = [];
  const inputFiles: string[] = [];
  const run: CommandRunner = async (exe, args) => {
    const key = `${exe} ${args.join(' ')}`;
    calls.push(key);
    const i = args.indexOf('--input');
    if (i >= 0) {
      const file = args[i + 1] as string;
      inputFiles.push(file);
      posts.push(JSON.parse(readFileSync(file, 'utf8')) as { body: string });
    }
    if (fail && key.startsWith(fail)) throw new Error('HTTP 502');
    const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    return hit ? hit[1] : '';
  };
  return { run, calls, posts, inputFiles };
}

const POST = 'gh api --method POST repos/';

describe('preparePrReviewCheckout', () => {
  it('fetches pull/N/head and the base branch, resolves head and merge base', async () => {
    const { run, calls } = fakeRun({
      'gh pr view 25': JSON.stringify({ baseRefName: 'main' }),
      'git rev-parse refs/cez/pr/25/head': `${HEAD}\n`,
      'git merge-base': `${BASE}\n`,
    });
    const checkout = await preparePrReviewCheckout('/repo', 25, run);
    expect(checkout).toEqual({ number: 25, headSha: HEAD, baseRef: 'origin/main', mergeBase: BASE });
    expect(calls[1]).toBe('git fetch --no-tags origin +refs/pull/25/head:refs/cez/pr/25/head +refs/heads/main:refs/remotes/origin/main');
    const context = renderPrReviewContext(checkout);
    expect(context).toContain(`git diff ${BASE} ${HEAD}`);
    expect(context).toContain('READ-ONLY');
    expect(context).toContain('plain repo-relative path:line');
  });

  it('fails without a base branch instead of guessing', async () => {
    const { run } = fakeRun({ 'gh pr view': '{}' });
    await expect(preparePrReviewCheckout('/repo', 1, run)).rejects.toThrow(/no base branch/);
  });
});

describe('publishPrReviewComment', () => {
  const base = { repoRoot: '/repo', repo: 'o/r', number: 25, headSha: HEAD, body: 'P1: foo.ts:12 bug' };

  it('posts once with the PR+HEAD marker', async () => {
    const { run, calls, posts } = fakeRun({ 'gh api --paginate': 'other comment\n' });
    await expect(publishPrReviewComment({ ...base, run })).resolves.toEqual({ status: 'published' });
    expect(calls[1]).toMatch(/^gh api --method POST repos\/o\/r\/issues\/25\/comments --input \S+comment\.json$/);
    expect(posts).toEqual([{ body: `P1: foo.ts:12 bug\n\n${prReviewMarker(25, HEAD)}` }]);
  });

  it('passes a review far over the Windows command-line limit via a JSON file, args stay short, file removed', async () => {
    const long = `${'P2: src/x.ts:1 "quoted" & $(not-a-command) '.repeat(4000)}end`;
    expect(long.length).toBeGreaterThan(4 * 32_768);
    const { run, calls, posts, inputFiles } = fakeRun({ 'gh api --paginate': '' });
    await expect(publishPrReviewComment({ ...base, body: long, run })).resolves.toEqual({ status: 'published' });
    expect(posts[0]?.body).toBe(`${long}\n\n${prReviewMarker(25, HEAD)}`);
    for (const c of calls) expect(c.length).toBeLessThan(500);
    expect(calls.some((c) => c.includes('P2: src/x.ts'))).toBe(false);
    expect(existsSync(inputFiles[0] as string)).toBe(false);
  });

  it('removes the temporary file when gh fails', async () => {
    const { run, inputFiles } = fakeRun({ 'gh api --paginate': '' }, POST);
    await expect(publishPrReviewComment({ ...base, run })).rejects.toThrow(/502/);
    expect(inputFiles).toHaveLength(1);
    expect(existsSync(inputFiles[0] as string)).toBe(false);
  });

  it('skips when the same PR+HEAD was already reviewed', async () => {
    const { run, calls } = fakeRun({ 'gh api --paginate': `old review\n\n${prReviewMarker(25, HEAD)}\n` });
    await expect(publishPrReviewComment({ ...base, run })).resolves.toEqual({ status: 'skipped-duplicate' });
    expect(calls).toHaveLength(1);
  });

  it('a new HEAD on the same PR is published again; dry-run posts nothing', async () => {
    const { run, calls } = fakeRun({ 'gh api --paginate': prReviewMarker(25, BASE) });
    const result = await publishPrReviewComment({ ...base, run, dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(calls).toHaveLength(1);
  });

  it('refuses an empty review', async () => {
    const { run } = fakeRun({});
    await expect(publishPrReviewComment({ ...base, body: '  ', run })).rejects.toThrow(/empty/);
  });

  it.each([
    '[src/a.ts](file:///C:/Users/Viktor/repo/src/a.ts:12)',
    'file:///home/viktor/repo/src/a.ts',
    'C:/Users/Viktor/repo/src/a.ts:12',
    'C:\\Users\\Viktor\\repo\\src\\a.ts:12',
    '\\\\host\\share\\repo\\src\\a.ts',
    '/home/viktor/repo/src/a.ts:12',
    '`/Users/viktor/repo/src/a.ts:12`',
    '~/repo/src/a.ts:12',
    '/tmp',
    '(//host/share/repo/src/a.ts)',
  ])('refuses local paths before any GitHub call: %s', async (body) => {
    const { run, calls } = fakeRun({});
    await expect(publishPrReviewComment({ ...base, body, run })).rejects.toThrow(/local path/);
    expect(calls).toEqual([]);
  });

  it('keeps repo-relative references and web links intact', async () => {
    const body = 'src/a.ts:12 and `docs/README.md:2`; https://github.com/o/r/pull/25';
    const { run, posts } = fakeRun({});
    await publishPrReviewComment({ ...base, body, run });
    expect(posts[0]?.body).toBe(`${body}\n\n${prReviewMarker(25, HEAD)}`);
  });
});

describe('checkReviewText', () => {
  const findings = 'P1: src/a.ts:12 off-by-one in the loop bound; fix the comparison.';
  it('accepts exactly one unambiguous recommendation with findings', () => {
    expect(checkReviewText(`${findings}\n\nRecommendation: APPROVE`)).toEqual({ ok: true, recommendation: 'APPROVE' });
    expect(checkReviewText(`${findings}\n\n**Recommendation: CHANGES REQUESTED**`)).toEqual({ ok: true, recommendation: 'CHANGES REQUESTED' });
  });
  it('refuses blank, bare "done", a missing, a conflicting, or a findings-less recommendation', () => {
    expect(checkReviewText('   ').ok).toBe(false);
    expect(checkReviewText('done').ok).toBe(false);
    expect(checkReviewText(`${findings}\nRecommendation: maybe`).ok).toBe(false);
    expect(checkReviewText(`${findings}\nRecommendation: APPROVE\nRecommendation: CHANGES REQUESTED`).ok).toBe(false);
    expect(checkReviewText('Recommendation: APPROVE').ok).toBe(false);
  });
  it('refuses two recommendation lines, identical or conflicting', () => {
    expect(checkReviewText(`${findings}\n\nRecommendation: APPROVE\nRecommendation: APPROVE`)).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly one/) });
    expect(checkReviewText(`${findings}\n\nRecommendation: CHANGES REQUESTED\n**Recommendation: CHANGES REQUESTED**`).ok).toBe(false);
    expect(checkReviewText(`${findings}\n\nRecommendation: CHANGES REQUESTED\nRecommendation: APPROVE`).ok).toBe(false);
  });
});

describe('publishReviewFromRun', () => {
  const target = { repo: 'metelskiwiktor/tabnote', number: 25, headSha: HEAD, baseRef: 'origin/main', mergeBase: BASE };
  const text = `${'P2: src/x.ts:1 long finding. '.repeat(200)}\n\nRecommendation: CHANGES REQUESTED`;
  const gh = (remoteHead: string, comments = '') => fakeRun({ 'gh api repos/metelskiwiktor/tabnote/pulls/25': `${remoteHead}\n`, 'gh api --paginate': comments });

  it('posts the full text (> 4000 chars) to the target repo, headed by the model the step ran', async () => {
    for (const model of ['google/gemini-3.8-flash-low', 'google/gemini-3.8-flash-medium']) {
      const { run, calls, posts } = gh(HEAD);
      await expect(publishReviewFromRun({ repoRoot: '/r', target, text, model, runner: 'agy', run })).resolves.toEqual({ status: 'published' });
      expect(calls.some((c) => c.startsWith(`${POST}metelskiwiktor/tabnote/issues/25/comments --input `))).toBe(true);
      const post = posts[0]?.body as string;
      expect(post.length).toBeGreaterThan(text.length);
      expect(post).toContain(`Automated review — model: ${model} (agy, via Cezar)\n\n${text}`);
      expect(post).toContain(prReviewMarker(25, HEAD));
    }
  });

  it("strips cezar's protocol markers (CEZ:PR=, CEZ:DONE) from the published review", async () => {
    const { run, posts } = gh(HEAD);
    const marked = `CEZ:PR=25\n\n${text}\nCEZ:DONE`;
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text: marked, run })).resolves.toEqual({ status: 'published' });
    const post = posts[0]?.body as string;
    expect(post).not.toMatch(/CEZ:(PR|DONE)/);
    expect(post).toContain('Recommendation: CHANGES REQUESTED\n\n<!-- cez-pr-review');
  });

  it('a moved PR HEAD is stale and posts nothing', async () => {
    const { run, calls } = gh(BASE);
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text, run })).resolves.toEqual({ status: 'stale', remoteHead: BASE });
    expect(calls.some((c) => c.startsWith(POST))).toBe(false);
  });

  it('an invalid target or review never reaches GitHub', async () => {
    const { run, calls } = gh(HEAD);
    for (const bad of [undefined, { ...target, repo: 'cezar' }, { ...target, number: 0 }, { ...target, headSha: 'abc' }]) {
      expect((await publishReviewFromRun({ repoRoot: '/r', target: bad, text, run })).status).toBe('invalid');
    }
    expect((await publishReviewFromRun({ repoRoot: '/r', target, text: 'done', run })).status).toBe('invalid');
    expect(calls).toEqual([]);
  });

  it('a review with a local path is invalid and never reaches GitHub', async () => {
    const { run, calls } = gh(HEAD);
    const result = await publishReviewFromRun({ repoRoot: '/r', target, text: `${text}\nfile:///C:/repo/src/x.ts`, run });
    expect(result).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/local path/) });
    expect(calls).toEqual([]);
  });

  it('a gh failure throws (the node turns it into its failed port)', async () => {
    const run: CommandRunner = async () => {
      throw new Error('HTTP 502');
    };
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text, run })).rejects.toThrow(/502/);
  });
});
