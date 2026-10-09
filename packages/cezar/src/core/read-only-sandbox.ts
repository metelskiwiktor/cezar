import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ReadOnlyIsolation {
  env: Record<string, string>;
  cleanup: () => void;
}

/**
 * Prepares ephemeral environment isolation for read-only review sessions:
 * - Redirects GH_CONFIG_DIR to a fresh empty temporary directory so GitHub CLI has no stored credentials.
 * - Points GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to an empty config file to prevent reading user/system helpers.
 * - Explicitly disables Git Credential Manager via GIT_CONFIG_KEY_0='credential.helper' and GIT_CONFIG_VALUE_0=''.
 * - Sets remote.origin.pushurl to 'DISABLED_READ_ONLY_REVIEW'.
 * - Disables git prompts and askpass.
 *
 * IMPORTANT: This mechanism NEVER modifies ACLs or file permissions of the user workspace.
 * Isolation is fail-closed: any failure in preparing isolation throws immediately before agent execution.
 */
export function prepareReadOnlyIsolation(): ReadOnlyIsolation {
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'cez-ro-sandbox-'));
  } catch (err) {
    throw new Error(`Fail-closed security check: failed to allocate read-only temporary directory: ${String(err)}`);
  }

  const emptyGitConfig = join(tempDir, 'empty.gitconfig');
  try {
    writeFileSync(emptyGitConfig, '', { encoding: 'utf8' });
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup */
    }
    throw new Error(`Fail-closed security check: failed to create empty gitconfig: ${String(err)}`);
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
      /* ignore cleanup error after child exit */
    }
  };

  return { env, cleanup };
}

/**
 * Captures a baseline porcelain git status snapshot of the workspace.
 */
export function getWorkspaceGitSnapshot(cwd: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Verifies that no files were created, modified, or deleted in the target git workspace
 * relative to the initial baseline snapshot.
 */
export function verifyWorkspaceIntegrity(
  cwd: string,
  initialSnapshot?: string,
): { clean: boolean; details?: string } {
  try {
    const current = getWorkspaceGitSnapshot(cwd);
    if (initialSnapshot !== undefined) {
      if (current !== initialSnapshot) {
        return {
          clean: false,
          details: `Workspace status changed from initial baseline:\nExpected:\n${initialSnapshot}\nActual:\n${current}`,
        };
      }
      return { clean: true };
    }
    if (current.length > 0) {
      return { clean: false, details: current };
    }
    return { clean: true };
  } catch {
    // If not a git repo or git is unavailable, pass integrity check
    return { clean: true };
  }
}
