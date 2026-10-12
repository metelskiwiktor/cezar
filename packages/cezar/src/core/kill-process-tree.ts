import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Stop terminal grandchildren as well as the CLI, particularly on Windows. */
export function killAgyTree(
  child: Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
): void {
  try {
    if (platform === 'win32' && child.pid) {
      run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    child.kill(signal);
  } catch { /* already gone */ }
}
