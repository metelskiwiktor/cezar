import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// readWorktreePath vets a path with lstat + realpath, then reads it. The agent writing the worktree
// runs concurrently, so this hook swaps the file the moment the realpath checks have resolved —
// the window CodeQL js/file-system-race (#14) points at.
const hook = vi.hoisted(() => ({ swap: null as null | (() => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      const swap = hook.swap;
      hook.swap = null;
      swap?.();
      return result;
    },
  };
});

const { readWorktreePath } = await import('./git-changes.ts');

function symlinksSupported(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'cez-race-probe-'));
  try {
    writeFileSync(join(dir, 'f'), 'x');
    symlinkSync(join(dir, 'f'), join(dir, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readWorktreePath — swap between the checks and the read', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    hook.swap = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('serves the file when nothing changes (guard)', async () => {
    const root = tmp('cez-race-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    const res = await readWorktreePath(root, 'a.txt');
    expect(res).toMatchObject({ kind: 'file', size: 5, content: 'hello' });
  });

  it('refuses a different file renamed over the vetted one', async () => {
    const root = tmp('cez-race-');
    writeFileSync(join(root, 'a.txt'), 'hello');
    writeFileSync(join(root, 'b.txt'), 'REPLACEMENT CONTENT');
    hook.swap = () => renameSync(join(root, 'b.txt'), join(root, 'a.txt'));
    const res = await readWorktreePath(root, 'a.txt');
    expect(res).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(res)).not.toContain('REPLACEMENT');
  });

  it.skipIf(!symlinksSupported())('refuses a symlink to a file outside the worktree swapped in', async () => {
    const root = tmp('cez-race-');
    const outside = tmp('cez-race-secret-');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    writeFileSync(join(root, 'a.txt'), 'hello');
    hook.swap = () => {
      unlinkSync(join(root, 'a.txt'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'a.txt'));
    };
    const res = await readWorktreePath(root, 'a.txt');
    expect(res).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(res)).not.toContain('TOP SECRET');
  });
});
