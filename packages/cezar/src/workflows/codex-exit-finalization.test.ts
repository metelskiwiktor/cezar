import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const fixture = vi.hoisted(() => ({ mode: 'done' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== 'test-codex-retained-stdout') return actual.spawn(...args);
      const child = actual.spawn(process.execPath, [join(import.meta.dirname, '../core/__fixtures__/codex/retained-stdout.mjs'), fixture.mode], args[2]);
      // Model an inherited writer independently of OS handle-inheritance rules.
      // Keep the real process exit, protocol and stdin, but withhold stdout EOF.
      const retained = new PassThrough();
      child.stdout!.pipe(retained, { end: false });
      Object.defineProperty(child, 'stdout', { value: retained });
      return child;
    },
  };
});

const git = promisify(execFile);
const workflow: WorkflowDef = {
  name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

describe('Codex process exit with stdout retained by a descendant', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string | undefined;

  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_CODEX_BIN', 'test-codex-retained-stdout');
    root = mkdtempSync(join(tmpdir(), 'cez-codex-exit-'));
    await git('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'base\n');
    await git('git', ['add', 'a.txt'], { cwd: root });
    await git('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    fixture.mode = 'done';
  });

  afterEach(async () => {
    if (id) manager.cancel(id);
    manager.dispose();
    store.flush();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    id = undefined;
  });

  for (const mode of ['done', 'error']) {
    it(`settles autonomous quick-task as ${mode === 'done' ? 'done' : 'failed'} after goal achieved, before descendant EOF`, async () => {
      fixture.mode = mode;
      id = manager.startRun(workflow, { task: 'Report the spike', runner: 'codex', autonomous: true, worktree: false }).id;
      const events = () => readFileSync(join(root, '.ai/cezar/runs', `${id}.ndjson`), 'utf8');
      await expect.poll(events, { timeout: 5000 }).toContain('goal achieved — session closed');
      // stdout never reaches EOF; settlement must follow process exit instead.
      await expect.poll(() => store.getRun(id!)?.status, { timeout: 1500 }).toBe(mode === 'done' ? 'done' : 'failed');
      expect(store.getRun(id)?.finishedAt).toBeTruthy();
      expect(store.getRun(id)?.steps[0]?.status).toBe(mode === 'done' ? 'done' : 'failed');
      expect(events()).toContain('Partial spike report.');
      expect(events()).toContain('session.ended');
      if (mode === 'error') expect(store.getRun(id)?.error).toContain('exited with code 1');
      store.flush();
      const reopened = RunStore.open(join(root, '.ai/cezar'));
      const persisted = reopened.getRun(id);
      expect(persisted?.status).toBe(mode === 'done' ? 'done' : 'failed');
      expect(persisted?.finishedAt).toBeTruthy();
      expect(reopened.readEvents(id).some((e) => e.type === 'text' && typeof e.text === 'string' && e.text.includes('Partial spike report.'))).toBe(true);
    });
  }

  it('keeps a quiet, genuinely live turn running', async () => {
    fixture.mode = 'live';
    id = manager.startRun(workflow, { task: 'Keep working', runner: 'codex', autonomous: true, worktree: false }).id;
    await expect.poll(() => store.readEvents(id!).some((e) => e.type === 'text'), { timeout: 5000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(id)?.status).toBe('running');
    expect(store.getRun(id)?.finishedAt).toBeUndefined();
    manager.cancel(id);
    expect(store.getRun(id)?.status).toBe('cancelled');
  });

  it('does not equate an ordinary turn-end with session exit and accepts a follow-up', async () => {
    id = manager.startRun(workflow, { task: 'First turn', runner: 'codex', worktree: false }).id;
    await expect.poll(() => store.getRun(id!)?.status, { timeout: 5000 }).toBe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.finishedAt).toBeUndefined();
    expect(manager.sendMessage(id, [{ type: 'text', text: 'Finish the report' }])).toBe(true);
    await expect.poll(() => store.getRun(id!)?.status, { timeout: 2000 }).toBe('done');
  });

  it('rejects an unanswered bootstrap RPC when the process exits with stdout still open', async () => {
    fixture.mode = 'bootstrap';
    const session = new CodexAppServerRunner({ timeoutMs: 0 }).startSession({ userPrompt: 'task', cwd: root });
    await expect(session.result).rejects.toThrow('codex app-server exited');
  }, 2000);
});
