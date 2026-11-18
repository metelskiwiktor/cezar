import { graphToSteps } from './graph.ts';
import type { WorkflowDef } from './types.ts';
import type { StepOverrides } from '@open-mercato/cezar-contract';
export { stepOverrideSchema, stepOverridesSchema, type StepOverrides } from '@open-mercato/cezar-contract';

/**
 * The workflow with the overrides written onto its agent steps — the run persists this def
 * (`workflowDef`), so a resumed or continued run keeps them. A new runner without a model drops
 * the pinned model (it named the old runner's model); the runner's own default resolves then.
 * An id that is not an agent step of this workflow is an error, never silently ignored.
 */
export function applyStepOverrides(workflow: WorkflowDef, overrides: StepOverrides): WorkflowDef | { error: string } {
  const ids = Object.keys(overrides);
  if (!ids.length) return workflow;
  const apply = <T extends { runner?: string; model?: string }>(node: T, o: StepOverrides[string]): T => {
    const { runner: _r, model: _m, ...rest } = node;
    const runner = o.runner ?? node.runner;
    const model = o.model ?? (o.runner && o.runner !== node.runner ? undefined : node.model);
    return { ...rest, ...(runner ? { runner } : {}), ...(model ? { model } : {}) } as T;
  };
  if (workflow.graph) {
    const agents = new Set(workflow.graph.nodes.filter((n) => n.type === 'agent').map((n) => n.id));
    const unknown = ids.filter((id) => !agents.has(id));
    if (unknown.length) return { error: `stepOverrides: not an agent step of "${workflow.name}": ${unknown.join(', ')}` };
    const graph = {
      ...workflow.graph,
      nodes: workflow.graph.nodes.map((n) => (n.type === 'agent' && overrides[n.id] ? apply(n, overrides[n.id]!) : n)),
    };
    return { ...workflow, graph, steps: graphToSteps(graph) };
  }
  const agents = new Set(workflow.steps.filter((s) => !s.command).map((s) => s.id));
  const unknown = ids.filter((id) => !agents.has(id));
  if (unknown.length) return { error: `stepOverrides: not an agent step of "${workflow.name}": ${unknown.join(', ')}` };
  return { ...workflow, steps: workflow.steps.map((s) => (overrides[s.id] ? apply(s, overrides[s.id]!) : s)) };
}
