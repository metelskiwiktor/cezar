/**
 * PR review (read-only automation): check out the reviewed PR's HEAD, tell the agent where the
 * base is, and — as the `pr-review` workflow's system node `github.review-comment`, after the
 * review agent SUCCEEDED — publish ONE comment per repo + PR + HEAD.
 *
 * The agent never gets GitHub credentials in read-only mode (agent-env), so publication is
 * cezar-side, with the orchestrator's own `gh` auth, never the agent's job. Which repo, PR and
 * HEAD are reviewed comes only from the orchestrator (`PrReviewTarget`, persisted on the run
 * record at launch), never from the prompt or the model's text.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** What a PR review run reviews and where its comment goes — persisted on the run record. */
export interface PrReviewTarget extends PrReviewCheckout {
  /** `owner/name` of the repository the PR lives in (the automation's poll target). */
  repo: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** Why a target cannot be published to, or null when it is sound. */
export function prReviewTargetIssue(target: Partial<PrReviewTarget> | undefined): string | null {
  if (!target) return 'this run has no PR review target (it was not launched by a PR review automation)';
  if (!target.repo || !REPO_RE.test(target.repo)) return `invalid PR review repo "${target.repo ?? ''}"`;
  if (!Number.isInteger(target.number) || (target.number ?? 0) <= 0) return `invalid PR number "${String(target.number)}"`;
  if (!target.headSha || !SHA_RE.test(target.headSha)) return `invalid reviewed head SHA "${target.headSha ?? ''}"`;
  return null;
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
    'Cite files as plain repo-relative path:line, never Markdown file links, file:// URLs or absolute local paths.',
    '---',
  ].join('\n');
}

/** Hidden marker that makes publication idempotent per PR + reviewed HEAD. */
export function prReviewMarker(number: number, headSha: string): string {
  return `<!-- cez-pr-review pr=${number} head=${headSha} -->`;
}

const RECOMMENDATION_RE = /^\s*\**\s*Recommendation\s*:?\s*\**\s*:?\s*(APPROVE|CHANGES REQUESTED)\s*\**\s*$/gim;

// Fail closed: without a verified checkout-relative mapping, stripping a prefix could point
// readers at a different file. Cover file URIs, Windows drives/UNC, Unix roots and home paths.
// Leading `/^.../` is a common regex literal in reviews, not a Unix path.
// Require the first filesystem path-segment character to look like a path name;
// continue rejecting real absolute paths, drive paths and file:// URLs.
const LOCAL_PATH_RE = /file:\/|\b[a-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|[\s`"'(<\[=])(?:~[\\/]|\/{1,2}[A-Za-z0-9._~-])/im;
const LOCAL_PATH_REASON = 'the review contains a local path; use plain repo-relative path:line';

/**
 * Whether an agent's final text is a complete review: non-blank, more than a bare
 * acknowledgement, and carrying exactly one unambiguous `Recommendation: APPROVE` /
 * `Recommendation: CHANGES REQUESTED` line.
 */
export function checkReviewText(text: string): { ok: true; recommendation: 'APPROVE' | 'CHANGES REQUESTED' } | { ok: false; reason: string } {
  const body = text.trim();
  if (!body) return { ok: false, reason: 'the review is empty' };
  if (LOCAL_PATH_RE.test(body)) return { ok: false, reason: LOCAL_PATH_REASON };
  const found = [...body.matchAll(RECOMMENDATION_RE)].map((m) => (m[1] as string).toUpperCase());
  if (found.length === 0) return { ok: false, reason: 'the review has no "Recommendation: APPROVE" or "Recommendation: CHANGES REQUESTED" line' };
  if (found.length > 1) return { ok: false, reason: `the review has ${found.length} recommendation lines (${found.join(', ')}); exactly one is required` };
  // A recommendation line alone is not a review.
  const rest = body.replace(RECOMMENDATION_RE, '').trim();
  if (rest.length < 40) return { ok: false, reason: 'the review has no findings or assessment, only a recommendation' };
  return { ok: true, recommendation: found[0] as 'APPROVE' | 'CHANGES REQUESTED' };
}

/** cezar's own in-band protocol lines (`CEZ:DONE`, `CEZ:PR=25`, …) — for cezar, not the PR. */
const CEZ_MARKER_LINE_RE = /^[ \t]*CEZ:(?:DONE|MONITORING|ASK|VERDICT|PR|ISSUE|TITLE)\b.*(?:\r?\n|$)/gm;

export function stripCezMarkers(text: string): string {
  return text.replace(CEZ_MARKER_LINE_RE, '').trim();
}

/** The comment's header — the model is what the review step actually ran with. */
export function prReviewHeader(model: string | undefined, runner: string | undefined): string {
  return `Automated review — model: ${model?.trim() || 'runner default'} (${runner?.trim() || 'agent'}, via Cezar)`;
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
 * Check-then-post: GitHub has no conditional create, so two publishers racing
 * on the same PR+HEAD can still both post — this prevents duplicates, it does
 * not make them impossible.
 */
export async function publishPrReviewComment(input: PublishPrReviewInput): Promise<PublishPrReviewResult> {
  const run = input.run ?? defaultCommandRunner;
  const body = input.body.trim();
  if (!body) throw new Error('refusing to publish an empty review');
  if (LOCAL_PATH_RE.test(body)) throw new Error(`refusing to publish: ${LOCAL_PATH_REASON}`);
  const marker = prReviewMarker(input.number, input.headSha);
  const existing = await run(
    'gh',
    ['api', '--paginate', `repos/${input.repo}/issues/${input.number}/comments`, '--jq', '.[].body'],
    input.repoRoot,
  );
  if (existing.includes(marker)) return { status: 'skipped-duplicate' };
  const full = `${body}\n\n${marker}`;
  if (input.dryRun) return { status: 'dry-run', body: full };
  // The body goes through a JSON file (`--input`), never argv: Windows caps a command line at
  // ~32k chars, and a long review must still post.
  const dir = await mkdtemp(join(tmpdir(), 'cez-pr-review-'));
  try {
    const file = join(dir, 'comment.json');
    await writeFile(file, JSON.stringify({ body: full }), 'utf8');
    await run('gh', ['api', '--method', 'POST', `repos/${input.repo}/issues/${input.number}/comments`, '--input', file], input.repoRoot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { status: 'published' };
}

/** The PR's current HEAD on GitHub (orchestrator auth). */
export async function remotePrHead(repoRoot: string, repo: string, number: number, run: CommandRunner = defaultCommandRunner): Promise<string> {
  return (await run('gh', ['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha'], repoRoot)).trim();
}

export interface PublishReviewRunInput {
  repoRoot: string;
  target: PrReviewTarget | undefined;
  /** The review agent's FULL final text (never a truncated summary). */
  text: string;
  /** The model the review step actually ran with (`provider/model`). */
  model?: string;
  runner?: string;
  dryRun?: boolean;
  run?: CommandRunner;
}

export type PublishReviewRunResult =
  | PublishPrReviewResult
  | { status: 'stale'; remoteHead: string }
  | { status: 'invalid'; reason: string };

/**
 * The `github.review-comment` node's work: validate the target and the review, refuse a stale
 * review (the PR moved on since the analysed HEAD), then publish once per repo + PR + HEAD.
 * Throws only on a gh/network failure.
 */
export async function publishReviewFromRun(input: PublishReviewRunInput): Promise<PublishReviewRunResult> {
  const targetIssue = prReviewTargetIssue(input.target);
  if (targetIssue) return { status: 'invalid', reason: targetIssue };
  const target = input.target as PrReviewTarget;
  const text = stripCezMarkers(input.text);
  const review = checkReviewText(text);
  if (!review.ok) return { status: 'invalid', reason: review.reason };
  const run = input.run ?? defaultCommandRunner;
  const remoteHead = await remotePrHead(input.repoRoot, target.repo, target.number, run);
  if (remoteHead !== target.headSha) return { status: 'stale', remoteHead };
  return publishPrReviewComment({
    repoRoot: input.repoRoot,
    repo: target.repo,
    number: target.number,
    headSha: target.headSha,
    body: `${prReviewHeader(input.model, input.runner)}\n\n${text}`,
    run,
    ...(input.dryRun ? { dryRun: true } : {}),
  });
}
