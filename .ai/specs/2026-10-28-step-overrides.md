# Step overrides: runner and model per agent step, per task

Status: implemented 2026-10-28.

## Problem

A workflow may pin an agent step to a runner and model (`runner:`/`model:` on the node). The pin
wins over the task's own `runner`/`model` (`node.runner ?? taskBackend`), which is right for a
workflow whose review must run on another model family than its implementation — but it means a
workflow runs on one set of agents only. Desk Panel's `desk-panel-task` pins implement/fix/address
to Codex and review to agy; with Codex's limit used up, the only way to run it on another agent
(e.g. DeepSeek through OpenCode and OpenRouter) was to edit the YAML or copy the workflow.

## Decision

`POST /runs` takes an optional `stepOverrides`: `{ [agentStepId]: { runner?, model? } }`, at least
one of the two per entry. `applyStepOverrides` (`packages/cezar/src/workflows/step-overrides.ts`)
writes them onto the workflow's agent nodes (or v1 steps) before the provider check, and the run
persists that def as `workflowDef`, so a resumed, continued or restarted run keeps them.

The run also stores optional `stepOverrides` and the unmodified `workflowSourceDef`. At dequeue,
catalog changes are compared with that source snapshot, then overrides are reapplied before the
effective definition is saved and executed. Overrides for removed or non-agent steps are skipped
with a lifecycle event. Legacy records without these fields retain their previous behavior.

- Order: override > the workflow's pin > the task's runner/model > config defaults.
- A new runner without a model drops the pinned model (it named the old runner's model).
- An id that is not an agent step of the workflow is a 400; nothing starts.
- With `agentModelsLocked`, an override naming a model is refused like `model` is (409).
- `session.continue` across runners already degrades to a fresh session with a note; callers
  that move a step whose session others continue should move those steps too.

The catalog workflow is never changed: the next task gets the pins again.
