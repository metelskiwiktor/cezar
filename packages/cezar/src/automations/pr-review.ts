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
import type { ReviewPublication } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

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

/**
 * Machine-owned context appended to the review task's prompt — runner-agnostic, and the ONE place
 * the review rubric and verdict format live. How the diff is delivered and how checks are run is
 * the runner's business (Agy gets a pinned diff file and Cezar-brokered checks), so this context
 * names the diff range without telling anyone to run a command.
 */
export function renderPrReviewContext(checkout: PrReviewCheckout): string {
  return [
    '---',
    'PR review checkout (prepared by cezar)',
    `Your working directory is a task worktree forked from the PR HEAD ${checkout.headSha}: its files ARE the PR's files.`,
    `Base branch: ${checkout.baseRef}; merge base: ${checkout.mergeBase}.`,
    `The PR diff is: git diff ${checkout.mergeBase} ${checkout.headSha} (if your runner supplies it as a file, read that file instead).`,
    'This is a READ-ONLY review: do not edit, create or delete files, do not commit, push, merge or comment on GitHub.',
    'Depth follows the size and risk of the diff: read the full diff, then the changed code your verdict depends on, its callers and tests, and AGENTS.md if the checkout has one — not every file. Tests are optional: prefer the targeted tests of the changed code, only when a result could change the verdict; a failure caused by the read-only sandbox (e.g. a blocked git push) is unverified, not a regression.',
    'Your final message is the review; cezar publishes it after the run succeeds. Format:',
    '- Findings, most severe first, each as P0, P1, P2 or P3 + repo-relative path:line + the problem and why it matters (P0 blocker/data loss/security, P1 incorrect behaviour or regression, P2 risk or missing coverage, P3 minor). Say "Findings: none" when there are none.',
    '- The checks you ran or requested with their outcome, checks skipped with the reason, and what you could not verify.',
    '- Exactly one final line, plain text: Recommendation: APPROVE, Recommendation: CHANGES REQUESTED (any P0/P1 finding) or Recommendation: COMMENT (nothing blocking, but too much unverified to approve).',
    'Cite files as plain repo-relative path:line, never Markdown file links, file:// URLs or absolute local paths.',
    `Optional inline comments on changed lines (new side of the diff): end the review with ONE fenced block tagged ${INLINE_COMMENTS_TAG} holding a JSON array, e.g.`,
    '```' + INLINE_COMMENTS_TAG,
    '[{"path":"src/a.ts","line":42,"body":"P1: off-by-one — use <= here."}]',
    '```',
    '---',
  ].join('\n');
}

/** Fence tag of the optional inline-comment block in a review's final text. */
export const INLINE_COMMENTS_TAG = 'cez-inline-comments';
export const INLINE_COMMENTS_MAX = 30;
const INLINE_BODY_MAX = 4_000;
const INLINE_BLOCK_RE = new RegExp(`^([ \\t]*)(?:(\`{3,})|(~{3,}))[ \\t]*${INLINE_COMMENTS_TAG}(?:[ \\t]+[^\\r\\n]*)?\\r?\\n([\\s\\S]*?)^[ \\t]*(?:\\2|\\3)[ \\t]*$`, 'gm');
const UNCLOSED_INLINE_BLOCK_RE = new RegExp(`^[ \\t]*(?:\`{3,}|~{3,})[ \\t]*${INLINE_COMMENTS_TAG}\\b[\\s\\S]*$`, 'm');
const STRAY_INLINE_TAG_RE = new RegExp(`(?:^|\\s)(?:\`{3,}|~{3,})[ \\t]*${INLINE_COMMENTS_TAG}\\b`, 'i');

/** One comment anchored to a line of the PR's HEAD (`side: RIGHT`). */
export interface InlineReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Split the optional `cez-inline-comments` blocks off a review. Each comment is validated on
 * its own: a bad entry (non-relative path, no line, local path in the body, over the cap) is
 * DROPPED and counted, never a reason to refuse the review it rides on. Malformed JSON drops
 * that block. The returned text no longer carries the blocks.
 */
export function extractInlineComments(text: string): { text: string; comments: InlineReviewComment[]; dropped: number } {
  const comments: InlineReviewComment[] = [];
  let dropped = 0;
  const closed = text.replace(INLINE_BLOCK_RE, (_all, _indent: string, _ticks: string, _tildes: string, json: string) => {
    let items: unknown;
    try {
      items = JSON.parse(json.trim());
    } catch {
      dropped++;
      return '';
    }
    for (const item of Array.isArray(items) ? items : [items]) {
      const c = inlineComment(item);
      if (c && comments.length < INLINE_COMMENTS_MAX) comments.push(c);
      else dropped++;
    }
    return '';
  });
  const rest = closed.replace(UNCLOSED_INLINE_BLOCK_RE, () => {
    dropped++;
    return '';
  });
  return { text: rest.trim(), comments, dropped };
}

function inlineComment(item: unknown): InlineReviewComment | null {
  if (!item || typeof item !== 'object') return null;
  const { path, line, body } = item as Record<string, unknown>;
  if (typeof path !== 'string' || typeof body !== 'string' || typeof line !== 'number') return null;
  const rel = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const text = body.trim();
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) return null;
  if (!Number.isSafeInteger(line) || line < 1 || !text || text.length > INLINE_BODY_MAX) return null;
  for (const s of [rel, text]) if (LOCAL_PATH_RE.test(s) || PRIVATE_OR_TRAVERSAL_PATH_RE.test(s)) return null;
  return { path: rel, line, body: text };
}

/** Inline comments GitHub would not anchor, folded into the main review as a list. */
function renderInlineFallback(comments: InlineReviewComment[]): string {
  return ['### Inline comments', '', ...comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body.replace(/\s*\n\s*/g, ' ')}`)].join('\n');
}

/** Hidden marker that makes publication idempotent per PR + reviewed HEAD. */
export function prReviewMarker(number: number, headSha: string): string {
  return `<!-- cez-pr-review pr=${number} head=${headSha} -->`;
}

const RECOMMENDATION_RE = /^\s*\**\s*Recommendation\s*:?\s*\**\s*:?\s*(APPROVE|CHANGES REQUESTED|COMMENT)\s*\**\s*$/gim;

// Fail closed: without a verified checkout-relative mapping, stripping a prefix could point
// readers at a different file. Cover file URIs, Windows drives/UNC, Unix roots and home paths.
// Leading `/^.../` or gitignore root anchors like `/.ai/...` are not absolute host paths.
// Reject real absolute paths (Unix roots /Users, /home, /tmp, etc.), Windows drives, UNC, home paths and file:// URLs.
export const LOCAL_PATH_RE = /file:\/|\b[a-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|[\s`"'(<\[=])\/\/[^\s\/]+[\\/][^\s\/]+|(?:^|[\s`"'(<\[=])~[\\/]|(?:^|[\s`"'(<\[=])\/(?:Users|home|tmp|private|var|etc|usr|opt|root|bin|sbin|lib|dev|proc|sys|mnt|Volumes)(?:[\\/]|$|[\s`"'\)>\]:,])/im;
export const LOCAL_PATH_REASON = 'the review contains a local path; use plain repo-relative path:line';
export const PRIVATE_OR_TRAVERSAL_PATH_RE = /(?:^|[\s`"'(<\[=\/\\])\.\.[\/\\]|\.ai[\/\\]cezar[\/\\](?:runs|worktrees|node-text|tmp)[\/\\][^\s`"'\)>\]\/\\]+/im;

/**
 * Whether an agent's final text is a complete review: non-blank, more than a bare
 * acknowledgement, and carrying exactly one unambiguous `Recommendation: APPROVE` /
 * `Recommendation: CHANGES REQUESTED` / `Recommendation: COMMENT` line.
 */
export type ReviewRecommendation = 'APPROVE' | 'CHANGES REQUESTED' | 'COMMENT';

export function checkReviewText(text: string): { ok: true; recommendation: ReviewRecommendation } | { ok: false; reason: string } {
  const body = text.trim();
  if (!body) return { ok: false, reason: 'the review is empty' };
  if (STRAY_INLINE_TAG_RE.test(body)) return { ok: false, reason: `the review contains an unparsed ${INLINE_COMMENTS_TAG} block` };
  if (LOCAL_PATH_RE.test(body)) return { ok: false, reason: LOCAL_PATH_REASON };
  if (PRIVATE_OR_TRAVERSAL_PATH_RE.test(body)) return { ok: false, reason: 'the review contains an external or private run path; cite only PR checkout files' };
  const found = [...body.matchAll(RECOMMENDATION_RE)].map((m) => (m[1] as string).toUpperCase());
  if (found.length === 0) return { ok: false, reason: 'the review has no "Recommendation: APPROVE", "Recommendation: CHANGES REQUESTED" or "Recommendation: COMMENT" line' };
  if (found.length > 1) return { ok: false, reason: `the review has ${found.length} recommendation lines (${found.join(', ')}); exactly one is required` };
  // A recommendation line alone is not a review.
  const rest = body.replace(RECOMMENDATION_RE, '').trim();
  if (rest.length < 40) return { ok: false, reason: 'the review has no findings or assessment, only a recommendation' };
  return { ok: true, recommendation: found[0] as ReviewRecommendation };
}

/** cezar's own in-band protocol lines (`CEZ:DONE`, `CEZ:PR=25`, …) — for cezar, not the PR. */
const CEZ_MARKER_LINE_RE = /^[ \t]*CEZ:(?:DONE|MONITORING|ASK|VERDICT|PR|ISSUE|TITLE)\b.*(?:\r?\n|$)/gm;

export function stripCezMarkers(text: string): string {
  return text.replace(CEZ_MARKER_LINE_RE, '').trim();
}

/** The one known inline executable literal that prose reviews mention: the POSIX launcher. */
const SH_LITERAL_RE = /(?<![\w/.\-])\/bin\/sh(?![\w/.\-])(?!\s+-)/g;
const SH_REPLACEMENT = 'POSIX shell';

/** Descriptive prose only: code spans other than exactly `/bin/sh` and links stay untouched. */
function rewriteShLiteral(line: string): string {
  if (/\]\(|:\/\/|<https?:/i.test(line)) return line;
  return line.split(/(`[^`]*`)/).map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return part.slice(1, -1).trim() === '/bin/sh' ? SH_REPLACEMENT : part;
    return part.replace(SH_LITERAL_RE, SH_REPLACEMENT);
  }).join('');
}

/** One deterministic formatting pass, not an agent retry or a path-prefix rewrite.
 * Only standalone inline executable literals in prose (a Windows executable path on an
 * "executable ... hardcoded" line, or exactly `/bin/sh`) are reworded. Finding locations,
 * source paths, links, code blocks, command snippets and ambiguous output fail closed.
 * Always revalidate the ENTIRE resulting body with the publisher's own validator.
 */
export function preflightReviewText(text: string): { text: string; repaired: boolean } {
  const original = stripCezMarkers(text);
  if (checkReviewText(original).ok) return { text: original, repaired: false };
  let fenced = false;
  const repaired = original.split('\n').map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    if (/location\s*:|^\s*(?:[-*]\s*)?(?:\[P[0-3]\]|P[0-3])\b/i.test(line)) return line;
    const sh = rewriteShLiteral(line);
    if (!/\b(?:executable|binary)\b.*\b(?:hardcoded|configured|set)\b/i.test(sh)) return sh;
    return sh.replace(/`(['"]?)([A-Za-z]:[\\/][^`\r\n]+?\.(?:exe|cmd|bat))\1`/g,
      '`[local executable path omitted]`');
  }).join('\n');
  return checkReviewText(repaired).ok ? { text: repaired, repaired: repaired !== original } : { text: original, repaired: false };
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
  /** Line comments posted as one GitHub PR review pinned to `headSha`. */
  inlineComments?: InlineReviewComment[];
  dryRun?: boolean;
  run?: CommandRunner;
}

export type PublishPrReviewResult =
  /** `inline`: line comments anchored on the PR; `inlineFallback`: GitHub refused the
   *  anchors, so they were folded into the review comment instead. */
  | { status: 'published'; inline?: number; inlineFallback?: number }
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
  if (PRIVATE_OR_TRAVERSAL_PATH_RE.test(body)) throw new Error('refusing to publish an external or private run path');
  const marker = prReviewMarker(input.number, input.headSha);
  const existing = await run(
    'gh',
    ['api', '--paginate', `repos/${input.repo}/issues/${input.number}/comments`, '--jq', '.[].body'],
    input.repoRoot,
  );
  if (existing.includes(marker)) return { status: 'skipped-duplicate' };
  const inline = input.inlineComments ?? [];
  if (input.dryRun) {
    const preview = inline.length ? `${body}\n\n${renderInlineFallback(inline)}` : body;
    return { status: 'dry-run', body: `${preview}\n\n${marker}` };
  }
  // Bodies go through a JSON file (`--input`), never argv: Windows caps a command line at
  // ~32k chars, and a long review must still post.
  const dir = await mkdtemp(join(tmpdir(), 'cez-pr-review-'));
  try {
    let full = `${body}\n\n${marker}`;
    let anchored = 0;
    if (inline.length) {
      // Line comments go first, as one review pinned to the reviewed commit and stamped with
      // `marker`. If a previous attempt posted the inline review and failed before posting the
      // main comment, the review already carries `marker` — skip reposting the inline review
      // and finish by posting only the missing main comment.
      const existingReviews = await run(
        'gh',
        ['api', '--paginate', `repos/${input.repo}/pulls/${input.number}/reviews`, '--jq', '.[].body'],
        input.repoRoot,
      );
      if (existingReviews.includes(marker)) {
        anchored = inline.length;
      } else {
        // A line outside the diff makes GitHub refuse the whole review (422): the comments then
        // ride in the main comment instead — a misplaced anchor never costs the review itself.
        const file = join(dir, 'review.json');
        await writeFile(file, JSON.stringify({
          commit_id: input.headSha,
          event: 'COMMENT',
          body: `Inline comments for the automated review of ${input.headSha.slice(0, 12)}.\n\n${marker}`,
          comments: inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
        }), 'utf8');
        try {
          await run('gh', ['api', '--method', 'POST', `repos/${input.repo}/pulls/${input.number}/reviews`, '--input', file], input.repoRoot);
          anchored = inline.length;
        } catch {
          full = `${body}\n\n${renderInlineFallback(inline)}\n\n${marker}`;
        }
      }
    }
    const file = join(dir, 'comment.json');
    await writeFile(file, JSON.stringify({ body: full }), 'utf8');
    await run('gh', ['api', '--method', 'POST', `repos/${input.repo}/issues/${input.number}/comments`, '--input', file], input.repoRoot);
    if (!inline.length) return { status: 'published' };
    return anchored ? { status: 'published', inline: anchored } : { status: 'published', inlineFallback: inline.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  /** Safe feedback without echoing the rejected local path. */
  onFormatRepair?: () => void;
  /** Inline comments that failed validation and were dropped (the review still publishes). */
  onInlineDropped?: (count: number) => void;
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
  const inline = extractInlineComments(input.text);
  if (inline.dropped) input.onInlineDropped?.(inline.dropped);
  const { text, repaired } = preflightReviewText(inline.text);
  const assessment = checkReviewText(text);
  if (!assessment.ok) return { status: 'invalid', reason: assessment.reason };
  const body = `${prReviewHeader(input.model, input.runner)}\n\n${text}`;
  const review = checkReviewText(body);
  if (!review.ok) return { status: 'invalid', reason: review.reason };
  if (repaired) input.onFormatRepair?.();
  const run = input.run ?? defaultCommandRunner;
  const remoteHead = await remotePrHead(input.repoRoot, target.repo, target.number, run);
  if (remoteHead !== target.headSha) return { status: 'stale', remoteHead };
  return publishPrReviewComment({
    repoRoot: input.repoRoot,
    repo: target.repo,
    number: target.number,
    headSha: target.headSha,
    body,
    ...(inline.comments.length ? { inlineComments: inline.comments } : {}),
    run,
    ...(input.dryRun ? { dryRun: true } : {}),
  });
}

export type ReviewPublicationInfo = ReviewPublication;

/** The `github.review-comment` node of a review run and the agent node it publishes. */
export function reviewPublishNode(run: Pick<RunRecord, 'workflowDef'>): { id: string; from: string } | undefined {
  const node = run.workflowDef?.graph?.nodes.find((n) => n.type === 'github.review-comment');
  return node && node.type === 'github.review-comment' ? { id: node.id, from: node.from } : undefined;
}

/**
 * Analysis and publication of a review run, reported separately. `savedText` is whether the
 * agent's full text was recorded; `active` whether the run is still working.
 */
export function reviewPublicationState(
  run: Pick<RunRecord, 'workflowDef' | 'steps' | 'graphState' | 'prReview'>,
  savedText: boolean,
  active: boolean,
): ReviewPublicationInfo | undefined {
  const node = run.prReview ? reviewPublishNode(run) : undefined;
  if (!node) return undefined;
  const complete = run.steps.find((s) => s.id === node.from)?.status === 'done' && savedText;
  const out = run.graphState?.outputs?.[node.id];
  const status = typeof out?.status === 'string' ? out.status : '';
  const reason = typeof out?.reason === 'string' ? out.reason : undefined;
  const sameHead = !out?.headSha || out.headSha === run.prReview?.headSha;
  let publication: ReviewPublicationInfo['publication'] = 'pending';
  if (sameHead && (status === 'published' || status === 'duplicate' || status === 'stale')) publication = status;
  else if (status === 'invalid' || status === 'failed') publication = 'blocked';
  return {
    analysis: complete ? 'complete' : 'incomplete',
    publication,
    ...(reason ? { reason } : {}),
    canRepublish: complete && publication === 'blocked' && !active,
  };
}
