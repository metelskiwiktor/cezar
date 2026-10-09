/**
 * PR review V1 (read-only automation): check out the reviewed PR's HEAD, tell the
 * agent where the base is, and — as a separate, explicit operator step after a
 * successful run — publish ONE comment per PR+HEAD.
 *
 * The agent never gets GitHub credentials in read-only mode (agent-env), so
 * publication is necessarily cezar/operator-side, never the agent's job.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CommandRunner = (executable: string, args: readonly string[], cwd: string) => Promise<string>;

export const defaultCommandRunner: CommandRunner = async (executable, args, cwd) => {
  const { stdout } = await execFileAsync(executable, [...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

export interface PrReviewCheckout {
  number: number;
  /** Commit the review worktree forks from (the PR's HEAD as fetched now). */
  headSha: string;
  /** The PR's target branch, as a remote-tracking ref (`origin/main`). */
  baseRef: string;
  /** `git merge-base baseRef headSha` — the lower bound of the PR diff. */
  mergeBase: string;
}

/**
 * Fetches the PR head (`pull/N/head`, works for forks too) and its base branch
 * into the project repository. Orchestrator-side: uses the host's own git/gh auth.
 */
export async function preparePrReviewCheckout(
  repoRoot: string,
  number: number,
  run: CommandRunner = defaultCommandRunner,
): Promise<PrReviewCheckout> {
  const view = JSON.parse(
    await run('gh', ['pr', 'view', String(number), '--json', 'baseRefName'], repoRoot),
  ) as { baseRefName?: string };
  const baseName = view.baseRefName?.trim();
  if (!baseName) throw new Error(`PR #${number}: gh returned no base branch`);

  const headRef = `refs/cez/pr/${number}/head`;
  await run('git', ['fetch', '--no-tags', 'origin', `+refs/pull/${number}/head:${headRef}`, `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`], repoRoot);
  // The fetched ref, not `headRefOid`: a push between the two calls reviews what was fetched.
  const headSha = (await run('git', ['rev-parse', `${headRef}^{commit}`], repoRoot)).trim();
  const baseRef = `origin/${baseName}`;
  const mergeBase = (await run('git', ['merge-base', baseRef, headSha], repoRoot)).trim();
  return { number, headSha, baseRef, mergeBase };
}

/** Machine-owned context appended to the review task's prompt. */
export function renderPrReviewContext(checkout: PrReviewCheckout): string {
  return [
    '---',
    'PR review checkout (prepared by cezar)',
    `Your working directory is a task worktree forked from the PR HEAD ${checkout.headSha}: its files ARE the PR's files.`,
    `Base branch: ${checkout.baseRef}; merge base: ${checkout.mergeBase}.`,
    `The PR diff is: git diff ${checkout.mergeBase} ${checkout.headSha}`,
    `Changed files: git diff --stat ${checkout.mergeBase} ${checkout.headSha}`,
    'This is a READ-ONLY review: do not edit, create or delete files, do not commit, push, merge or comment on GitHub.',
    'Your final message is the review; cezar publishes it after the run succeeds.',
    '---',
  ].join('\n');
}

/** Hidden marker that makes publication idempotent per PR + reviewed HEAD. */
export function prReviewMarker(number: number, headSha: string): string {
  return `<!-- cez-pr-review pr=${number} head=${headSha} -->`;
}

export interface PublishPrReviewInput {
  repoRoot: string;
  /** `owner/name` */
  repo: string;
  number: number;
  headSha: string;
  body: string;
  dryRun?: boolean;
  run?: CommandRunner;
}

export type PublishPrReviewResult =
  | { status: 'published' }
  | { status: 'skipped-duplicate' }
  | { status: 'dry-run'; body: string };

/**
 * Posts the review as ONE PR comment, unless a comment carrying the same
 * PR+HEAD marker already exists. Call only after the review run succeeded.
 */
export async function publishPrReviewComment(input: PublishPrReviewInput): Promise<PublishPrReviewResult> {
  const run = input.run ?? defaultCommandRunner;
  const body = input.body.trim();
  if (!body) throw new Error('refusing to publish an empty review');
  const marker = prReviewMarker(input.number, input.headSha);
  const existing = await run(
    'gh',
    ['api', '--paginate', `repos/${input.repo}/issues/${input.number}/comments`, '--jq', '.[].body'],
    input.repoRoot,
  );
  if (existing.includes(marker)) return { status: 'skipped-duplicate' };
  const full = `${body}\n\n${marker}`;
  if (input.dryRun) return { status: 'dry-run', body: full };
  await run('gh', ['api', `repos/${input.repo}/issues/${input.number}/comments`, '-f', `body=${full}`], input.repoRoot);
  return { status: 'published' };
}
