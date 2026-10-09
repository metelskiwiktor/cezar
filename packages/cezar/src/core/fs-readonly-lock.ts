import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Enforces OS-level file system read-only locks on target directory.
 * Prevents writes BEFORE execution on kernel level (NTFS ACL Deny Write on Win32, chmod a-w on POSIX).
 */
export function acquireFileSystemReadOnlyLock(dir: string): () => void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || 'Users';
    try {
      execFileSync('icacls', [dir, '/deny', `${user}:(WD,AD,WEA,WA)`, '/t', '/c'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return () => {
        try {
          execFileSync('icacls', [dir, '/remove:d', user, '/t', '/c'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          /* ignore release errors */
        }
      };
    } catch {
      return () => {};
    }
  }

  // POSIX fallback:
  try {
    execFileSync('chmod', ['-R', 'a-w', dir], { stdio: 'ignore' });
    return () => {
      try {
        execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Sandboxes the environment for read-only review sessions:
 * - Drops all GitHub mutation tokens (GITHUB_TOKEN, GH_TOKEN, GITHUB_PAT, GH_ENTERPRISE_TOKEN)
 * - Diverts GH_CONFIG_DIR to an isolated empty directory so `gh` CLI has no logged-in sessions
 * - Disables git push and prompt interactions (pushurl to disabled sentinel, terminal prompts disabled)
 */
export function setupReadOnlyEnvironment(extraEnv?: Record<string, string>): {
  env: Record<string, string>;
  cleanup: () => void;
} {
  const emptyGhDir = mkdtempSync(join(tmpdir(), 'cez-gh-ro-'));
  const sandboxedEnv: Record<string, string> = {
    ...(extraEnv ?? {}),
    GH_CONFIG_DIR: emptyGhDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_0: 'DISABLED_READ_ONLY_REVIEW',
  };

  delete sandboxedEnv.GITHUB_TOKEN;
  delete sandboxedEnv.GH_TOKEN;
  delete sandboxedEnv.GITHUB_PAT;
  delete sandboxedEnv.GH_ENTERPRISE_TOKEN;

  return {
    env: sandboxedEnv,
    cleanup: () => {
      try {
        rmSync(emptyGhDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
