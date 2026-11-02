import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

describe('agent step timeoutMs passing to runner spec', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  const DEF_WITH_TIMEOUT: WorkflowDef = {
    name: 'with-timeout',
    source: 'file',
    steps: [
      { id: 'work', name: 'Work', prompt: '{{task}}', timeoutMs: 3_600_000 },
      { id: 'verify', command: 'true' },
    ],
  };

  const DEF_WITHOUT_TIMEOUT: WorkflowDef = {
    name: 'without-timeout',
    source: 'file',
    steps: [
      { id: 'work', name: 'Work', prompt: '{{task}}' },
      { id: 'verify', command: 'true' },
    ],
  };

  const DEF_INTERACTIVE: WorkflowDef = {
    name: 'interactive-step',
    source: 'file',
    steps: [
      { id: 'work', name: 'Work', prompt: '{{task}}', timeoutMs: 3_600_000 },
    ],
  };

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agent-step-timeout-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled', 'waiting'].includes(String(status)));
  }

  it('passes configured timeoutMs for a non-interactive agent step', async () => {
    const record = manager!.startRun(DEF_WITH_TIMEOUT, { task: 'test task', worktree: false, runner: 'claude' });
    const spec = await specAt(0);
    expect(spec.timeoutMs).toBe(3_600_000);
    await settled(record.id);
  });

  it('leaves timeoutMs undefined when not configured (runner default)', async () => {
    const record = manager!.startRun(DEF_WITHOUT_TIMEOUT, { task: 'test task', worktree: false, runner: 'claude' });
    const spec = await specAt(0);
    expect(spec.timeoutMs).toBeUndefined();
    await settled(record.id);
  });

  it('sets timeoutMs to 0 for interactive steps even if timeoutMs is configured', async () => {
    const record = manager!.startRun(DEF_INTERACTIVE, { task: 'test task', worktree: false, runner: 'claude' });
    const spec = await specAt(0);
    expect(spec.timeoutMs).toBe(0);
    await settled(record.id);
  });
});
