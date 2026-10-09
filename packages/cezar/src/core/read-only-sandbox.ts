import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Read-only review mode — what it does and does NOT guarantee.
 *
 * Real (enforced by cezar):
 *  - GitHub/git credentials are not forwarded to the agent (agent-env + the
 *    empty gh/git config below), so `gh`/`git push` from the agent fail to auth.
 *  - The checkout is snapshotted (HEAD + `git status`) before and after the run;
 *    any change fails the run, also on timeout/cancel.
 *  - The agent process tree is killed on timeout/cancel/violation.
 *
 * Best-effort (NOT an OS boundary):
 *  - The review-only prompt and the mutating-tool tripwire. agy runs as the
 *    operator's own user; it can still read the user's files and run commands.
 *    There is no OS sandbox, VM or separate account in this MVP.
 */
export interface ReadOnlyIsolation {
  env: Record<string, string>;
  cleanup: () => void;
}

/**
 * Ephemeral env for read-only runs: empty GH_CONFIG_DIR, empty global/system
 * git config, no credential helper, no prompts, push URL disabled.
 * Throws (before the agent is spawned) if the temp dir cannot be created.
 */
export function prepareReadOnlyIsolation(): ReadOnlyIsolation {
  const tempDir = mkdtempSync(join(tmpdir(), 'cez-ro-'));
  const emptyGitConfig = join(tempDir, 'empty.gitconfig');
  try {
    writeFileSync(emptyGitConfig, '', { encoding: 'utf8' });
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  const env: Record<string, string> = {
    GH_CONFIG_DIR: tempDir,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: 'DISABLED_READ_ONLY_REVIEW',
  };

  const cleanup = () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort after child exit */
    }
  };

  return { env, cleanup };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

/**
 * HEAD + full porcelain status (untracked files included). Catches edits, new
 * files, deletions, commits and branch switches. Not a content hash: a file
 * that was already dirty and is edited again is not detected (acceptable for
 * a clean review worktree). `undefined` when `cwd` is not a git checkout.
 */
export function getWorkspaceGitSnapshot(cwd: string): string | undefined {
  try {
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const status = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
    return `HEAD ${head}\n${status}`;
  } catch {
    return undefined;
  }
}

/**
 * Compares against the baseline. A git failure after a successful baseline is
 * reported as not clean — it is never silently treated as "no changes".
 */
export function verifyWorkspaceIntegrity(
  cwd: string,
  initialSnapshot?: string,
): { clean: boolean; details?: string } {
  const current = getWorkspaceGitSnapshot(cwd);
  if (current === undefined) {
    return initialSnapshot === undefined
      ? { clean: true }
      : { clean: false, details: 'git state could not be read after the run' };
  }
  const baseline = initialSnapshot ?? `HEAD ${current.split('\n')[0]!.slice(5)}\n`;
  if (current.trim() !== baseline.trim()) {
    return { clean: false, details: `expected:\n${baseline}\nactual:\n${current}` };
  }
  return { clean: true };
}
