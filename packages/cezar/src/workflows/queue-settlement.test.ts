import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as repoGit from '../server/git.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

it('releasing the last slot with no queued jobs does not spawn git in a settled repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-empty-queue-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const semaphore = new WorkspaceSemaphore();
  const manager = new RunManager(store, root, { semaphore });
  const inspect = vi.spyOn(repoGit, 'getRepoInfo').mockResolvedValue(null);
  try {
    // The same workspace broadcast settlement fires before the test/server
    // removes the repository. It must reconcile timers without launching git
    // when there is no job to dequeue or capacity decision to make.
    await semaphore.release();
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    inspect.mockRestore();
    manager.dispose();
    store.flush();
    await rm(root, { recursive: true, force: true });
  }
});
