import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/** `POST /api/v1/runs` `stepOverrides` (spec 2026-10-28-step-overrides): the manager gets the
 *  workflow with the overrides written onto its steps — the def the run persists. */
describe('POST /api/v1/runs stepOverrides', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let started: WorkflowDef | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-overrides-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = undefined;
    const manager = {
      startRun: (workflow: WorkflowDef, input: { task: string }) => {
        started = workflow;
        return store.createRun({ title: 't', workflow: workflow.name, task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}', runner: 'codex', model: 'gpt-x' }] };

  it('writes the override onto the pinned step', async () => {
    const res = await post({ ...base, stepOverrides: { work: { runner: 'opencode', model: 'openrouter/deepseek/v4' } } });
    expect(res.status).toBe(201);
    expect(started?.steps[0]).toMatchObject({ runner: 'opencode', model: 'openrouter/deepseek/v4' });
  });

  it('without overrides the pins stay', async () => {
    expect((await post(base)).status).toBe(201);
    expect(started?.steps[0]).toMatchObject({ runner: 'codex', model: 'gpt-x' });
  });

  it('refuses an unknown step and a malformed override before anything starts', async () => {
    const unknown = await post({ ...base, stepOverrides: { review: { runner: 'claude' } } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: expect.stringContaining('review') });
    expect((await post({ ...base, stepOverrides: { work: {} } })).status).toBe(400);
    expect((await post({ ...base, stepOverrides: { work: { runner: 'nope' } } })).status).toBe(400);
    expect(started).toBeUndefined();
  });
});
