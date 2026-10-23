# Workflow model defaults

Owner request: Claude analysis defaults to Opus and implementation to Sonnet;
Codex uses gpt-6.1-sol for both, with medium reasoning in its native config.
An explicit task model must remain selectable.

Project config `workflowModels` maps workflow names to per-runner model ids.
The task form and the engine resolve explicit task model (including empty auto),
then the workflow's entry for that runner, then the project model preset, then
native agent settings. Existing fixed per-step model/runner assignments and the
native-model lock retain their precedence. Nothing is chosen for another runner.

The engine persists the effective task model for subsequent continuations.
Changing runners with no explicit model discards a foreign inherited pin and
resolves defaults for the new backend. Workflow defaults are project-local;
projects without them keep the native fallback unless a project preset exists.

GET config exposes the optional map. PUT replaces the map or clears it on null.
The API, direct CLI and UI share the engine behavior. Codex reasoning effort is
left in its native configuration, with no new competing Cezar effort setting.

Verification: config precedence and isolation tests, API roundtrip and contract
parity, engine-to-runner model capture, task form display and manual override,
and independent Codex model selection. The precedence regression fails when
workflow resolution is removed.

Standalone review defaults (owner clarification): `workflowRunners.pr-review`
selects agy, and `workflowModels.pr-review.agy` selects
gemini-3.8-flash-medium. Explicit runner/model choices still win. Embedded review
steps in implement-review-pr and review-council are unchanged. The adapter reads
the project workflow runner before normalization/idempotency; the dedicated
review_pr tool retains its existing explicit agy default. The UI includes agy
in its provider order and runner picker so it cannot substitute Claude.

Owner cleanup: quick-task explicitly defaults to Sonnet for Claude and
gpt-6.1-sol for Codex in all four projects. Remove implement-and-verify, fix-ci,
implement-review-pr and review-council from the built-in catalog. Keep stored
run definitions/history; project workflows tabnote-task and implement-and-e2e
remain available. Remove obsolete model defaults for the removed catalog entries.
