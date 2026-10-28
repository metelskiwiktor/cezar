import { describe, expect, it } from 'vitest';
import { workflowGraphSchema } from './graph.ts';
import { applyStepOverrides, stepOverridesSchema } from './step-overrides.ts';
import type { WorkflowDef } from './types.ts';

// spec 2026-10-28-step-overrides
const graph = workflowGraphSchema.parse({
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'implement', type: 'agent', prompt: '{{task}}', runner: 'codex', model: 'gpt-x' },
    { id: 'test', type: 'check', command: 'npm test' },
    { id: 'review', type: 'agent', prompt: 'review', runner: 'agy', model: 'opus-low', verdicts: ['ok', 'changes'] },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'implement' },
    { from: 'implement', to: 'test' },
    { from: 'test.pass', to: 'review' },
    { from: 'review.ok', to: 'end' },
  ],
});
const def: WorkflowDef = { name: 'task', source: 'file', graph, steps: [] };

describe('applyStepOverrides', () => {
  it('wins over a pinned runner and model, and leaves the other steps as pinned', () => {
    const out = applyStepOverrides(def, { implement: { runner: 'opencode', model: 'openrouter/deepseek/v4' } });
    if ('error' in out) throw new Error(out.error);
    expect(out.graph!.nodes.find((n) => n.id === 'implement')).toMatchObject({ runner: 'opencode', model: 'openrouter/deepseek/v4' });
    expect(out.graph!.nodes.find((n) => n.id === 'review')).toMatchObject({ runner: 'agy', model: 'opus-low', verdicts: ['ok', 'changes'] });
    // The derived steps follow the graph, so step-reading paths see the override too.
    expect(out.steps.find((s) => s.id === 'implement')).toMatchObject({ runner: 'opencode', model: 'openrouter/deepseek/v4' });
    // The catalog def is untouched: the next task gets the pins again.
    expect(def.graph!.nodes.find((n) => n.id === 'implement')).toMatchObject({ runner: 'codex', model: 'gpt-x' });
  });

  it('drops the pinned model when only the runner changes, and keeps it when only the model does', () => {
    const runnerOnly = applyStepOverrides(def, { implement: { runner: 'claude' } });
    if ('error' in runnerOnly) throw new Error(runnerOnly.error);
    const implement = runnerOnly.graph!.nodes.find((n) => n.id === 'implement')!;
    expect(implement).toMatchObject({ runner: 'claude' });
    expect('model' in implement).toBe(false);
    const modelOnly = applyStepOverrides(def, { review: { model: 'opus-high' } });
    if ('error' in modelOnly) throw new Error(modelOnly.error);
    expect(modelOnly.graph!.nodes.find((n) => n.id === 'review')).toMatchObject({ runner: 'agy', model: 'opus-high' });
  });

  it('refuses an id that is not an agent step, and an empty override', () => {
    expect(applyStepOverrides(def, { test: { runner: 'claude' } })).toEqual({ error: expect.stringContaining('test') });
    expect(applyStepOverrides(def, { nope: { runner: 'claude' } })).toEqual({ error: expect.stringContaining('nope') });
    expect(stepOverridesSchema.safeParse({ implement: {} }).success).toBe(false);
    expect(stepOverridesSchema.safeParse({ implement: { runner: 'gpt' } }).success).toBe(false);
  });

  it('applies to a v1 chain of steps too', () => {
    const v1: WorkflowDef = { name: 'chain', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}', runner: 'codex' }, { id: 'lint', command: 'npm run lint' }] };
    const out = applyStepOverrides(v1, { work: { runner: 'pi', model: 'openrouter/x' } });
    if ('error' in out) throw new Error(out.error);
    expect(out.steps[0]).toMatchObject({ runner: 'pi', model: 'openrouter/x' });
    expect(applyStepOverrides(v1, { lint: { runner: 'pi' } })).toEqual({ error: expect.stringContaining('lint') });
  });
});
