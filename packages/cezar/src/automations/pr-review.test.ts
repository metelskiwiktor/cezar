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

function fakeRun(responses: Record<string, string>): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (exe, args) => {
    const key = `${exe} ${args.join(' ')}`;
    calls.push(key);
    const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    return hit ? hit[1] : '';
  };
  return { run, calls };
}

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
  });

  it('fails without a base branch instead of guessing', async () => {
    const { run } = fakeRun({ 'gh pr view': '{}' });
    await expect(preparePrReviewCheckout('/repo', 1, run)).rejects.toThrow(/no base branch/);
  });
});

describe('publishPrReviewComment', () => {
  const base = { repoRoot: '/repo', repo: 'o/r', number: 25, headSha: HEAD, body: 'P1: foo.ts:12 bug' };

  it('posts once with the PR+HEAD marker', async () => {
    const { run, calls } = fakeRun({ 'gh api --paginate': 'other comment\n' });
    await expect(publishPrReviewComment({ ...base, run })).resolves.toEqual({ status: 'published' });
    const post = calls.find((c) => c.startsWith('gh api repos/o/r/issues/25/comments -f'));
    expect(post).toContain(prReviewMarker(25, HEAD));
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
});

describe('publishReviewFromRun', () => {
  const target = { repo: 'metelskiwiktor/tabnote', number: 25, headSha: HEAD, baseRef: 'origin/main', mergeBase: BASE };
  const text = `${'P2: src/x.ts:1 long finding. '.repeat(200)}\n\nRecommendation: CHANGES REQUESTED`;
  const gh = (remoteHead: string, comments = '') => fakeRun({ 'gh api repos/metelskiwiktor/tabnote/pulls/25': `${remoteHead}\n`, 'gh api --paginate': comments });

  it('posts the full text (> 4000 chars) to the target repo, headed by the model the step ran', async () => {
    for (const model of ['google/gemini-3.8-flash-low', 'google/gemini-3.8-flash-medium']) {
      const { run, calls } = gh(HEAD);
      await expect(publishReviewFromRun({ repoRoot: '/r', target, text, model, runner: 'agy', run })).resolves.toEqual({ status: 'published' });
      const post = calls.find((c) => c.startsWith('gh api repos/metelskiwiktor/tabnote/issues/25/comments -f')) as string;
      expect(post.length).toBeGreaterThan(text.length);
      expect(post).toContain(`body=Automated review — model: ${model} (agy, via Cezar)\n\n${text}`);
      expect(post).toContain(prReviewMarker(25, HEAD));
    }
  });

  it("strips cezar's protocol markers (CEZ:PR=, CEZ:DONE) from the published review", async () => {
    const { run, calls } = gh(HEAD);
    const marked = `CEZ:PR=25\n\n${text}\nCEZ:DONE`;
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text: marked, run })).resolves.toEqual({ status: 'published' });
    const post = calls.find((c) => c.includes('-f body=')) as string;
    expect(post).not.toMatch(/CEZ:(PR|DONE)/);
    expect(post).toContain('Recommendation: CHANGES REQUESTED\n\n<!-- cez-pr-review');
  });

  it('a moved PR HEAD is stale and posts nothing', async () => {
    const { run, calls } = gh(BASE);
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text, run })).resolves.toEqual({ status: 'stale', remoteHead: BASE });
    expect(calls.some((c) => c.includes('-f body='))).toBe(false);
  });

  it('an invalid target or review never reaches GitHub', async () => {
    const { run, calls } = gh(HEAD);
    for (const bad of [undefined, { ...target, repo: 'cezar' }, { ...target, number: 0 }, { ...target, headSha: 'abc' }]) {
      expect((await publishReviewFromRun({ repoRoot: '/r', target: bad, text, run })).status).toBe('invalid');
    }
    expect((await publishReviewFromRun({ repoRoot: '/r', target, text: 'done', run })).status).toBe('invalid');
    expect(calls).toEqual([]);
  });

  it('a gh failure throws (the node turns it into its failed port)', async () => {
    const run: CommandRunner = async () => {
      throw new Error('HTTP 502');
    };
    await expect(publishReviewFromRun({ repoRoot: '/r', target, text, run })).rejects.toThrow(/502/);
  });
});
