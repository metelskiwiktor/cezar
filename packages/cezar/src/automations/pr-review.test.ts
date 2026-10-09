import { describe, expect, it } from 'vitest';
import {
  preparePrReviewCheckout,
  prReviewMarker,
  publishPrReviewComment,
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
