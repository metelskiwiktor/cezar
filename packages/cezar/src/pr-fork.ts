import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSafeGitRef } from './git-refs.ts';
import type { WorkflowDef } from './workflows/types.ts';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', args, {
  cwd, encoding: 'utf8', timeout: 15_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();

async function fetchTarget(cwd: string, targetBranch: string): Promise<void> {
  await git(cwd, ['check-ref-format', `refs/heads/${targetBranch}`]);
  if (process.env.CEZ_DRY_RUN !== '1') {
    await git(cwd, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin',
      `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`]);
  }
}

export interface PrForkBase {
  sha: string;
  targetBranch: string;
  remoteUrl: string;
}

/** Structural intent, independent of autonomy/force-start and of which graph path wins. */
export function producesPullRequest(workflow: WorkflowDef): boolean {
  return workflow.graph?.nodes.some((n) => n.type === 'github.draft-pr') ?? false;
}

/** No local/HEAD fallback. Resolve once, before worktree creation or any agent/check. */
export async function resolvePrForkBase(repoRoot: string, configured?: string): Promise<PrForkBase> {
  try {
    let targetBranch = configured?.replace(/^origin\//, '');
    if (targetBranch && !isSafeGitRef(targetBranch)) throw new Error('option-like target branch');
    const remoteUrl = await git(repoRoot, ['remote', 'get-url', 'origin']);
    if (!remoteUrl) throw new Error('origin has no URL');
    // With no project override, use origin's advertised default, never the local checkout.
    if (!targetBranch) {
      const advertised = process.env.CEZ_DRY_RUN === '1'
        ? await git(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
        : await git(repoRoot, ['ls-remote', '--symref', 'origin', 'HEAD']);
      targetBranch = process.env.CEZ_DRY_RUN === '1'
        ? advertised.replace(/^refs\/remotes\/origin\//, '')
        : /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(advertised)?.[1];
      if (!targetBranch) throw new Error('cannot discover origin default branch; configure baseBranch');
    }
    if (!isSafeGitRef(targetBranch)) throw new Error('option-like target branch');
    // Dry-run is network-free, but still requires a seeded remote-tracking ref.
    await fetchTarget(repoRoot, targetBranch);
    const sha = await git(repoRoot, ['rev-parse', '--verify', `refs/remotes/origin/${targetBranch}^{commit}`]);
    if (await git(repoRoot, ['remote', 'get-url', 'origin']) !== remoteUrl) throw new Error('origin URL changed during pre-flight');
    return { sha, targetBranch, remoteUrl };
  } catch (err) {
    throw new Error(`PR pre-flight failed: cannot pin fresh origin/${configured ?? '<default>'}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Provenance gate before publishing. Path/scope policies remain workflow-specific. */
export async function validatePrFork(cwd: string, branch: string, base: PrForkBase): Promise<string> {
  if (!isSafeGitRef(branch) || !isSafeGitRef(base.targetBranch) || !/^[0-9a-f]{40}$/.test(base.sha)) {
    throw new Error('invalid pinned PR base or task branch');
  }
  if (await git(cwd, ['symbolic-ref', '--short', 'HEAD']) !== branch) throw new Error('HEAD is not the task branch');
  if (await git(cwd, ['remote', 'get-url', 'origin']) !== base.remoteUrl) throw new Error('origin URL changed since PR pre-flight');
  await git(cwd, ['merge-base', '--is-ancestor', base.sha, 'HEAD']);
  // An advanced target is fine; a rewrite that drops the fork would reintroduce inherited
  // history into the PR. Refresh/check reachability without ever changing the recorded SHA.
  await fetchTarget(cwd, base.targetBranch);
  if (await git(cwd, ['remote', 'get-url', 'origin']) !== base.remoteUrl) throw new Error('origin URL changed during PR scope check');
  const targetSha = await git(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${base.targetBranch}^{commit}`]);
  await git(cwd, ['merge-base', '--is-ancestor', base.sha, targetSha]);
  return targetSha;
}
