# Codex finalization investigation (2026-10-18)

## Incident evidence and limits

Read-only inspection of project cezar's existing files found:

- Run `6e5aa9f2-b248-44c4-b785-227b0ad5674c` is an autonomous Codex
  `quick-task`, started at `2026-10-18T15:46:22.225Z`.
- Its `runs.json` record still says `running`, with step `task` running and no
  `finishedAt`.
- Its NDJSON ends at seq 604, `2026-10-18T15:52:43.906Z`, with
  `goal achieved — session closed`. The preceding events are final assistant
  prose (seq 599), usage, `turn.completed` (602) and `turn-end` (603).
  There is no runner `done` or manager `session.ended` afterward.
- Its handoff contains the corresponding close heartbeat at `15:52:43.907Z`.
- The installed runner and transport have the same stdout-before-exit ordering
  as this branch's original source. A read-only Windows process inventory
  found no Codex app-server from the incident's start time; the only Codex
  app-server directly parented by the cockpit was this investigation's session.

The lifecycle message records an **intent to close**, before `session.end()`;
it is not a process-exit acknowledgement. The engine awaits `session.result`
before emitting `session.ended`, completing the step and persisting the run's
terminal state. Changing an API/UI projection would hide the unfinished engine
operation. The `get_task` names `terminal`, `lastMessage` and `finalMessage` are
not fields of this repository's run store; no adapter changes were made.

**The historical incident's exact cause remains unconfirmed.** No historical
root PID, exit code or handle-owner trace was available. The event boundary and
absence of an old Codex process support a blocked session-settlement hypothesis,
but do not prove which promise or OS handle was left pending. A real Node
descendant experiment on this Windows host did *not* retain stdout EOF; this
must not be presented as a native Codex handle-inheritance reproduction.

## Confirmed bug and bounded fix

`CodexSession.result` awaited `Promise.all([bootstrap, readLoop])` before waiting
for process exit. A reader whose writer remains open can therefore strand a
finished process indefinitely. Also, EOF during an unanswered bootstrap RPC
left bootstrap pending: pending RPCs were rejected only *after* that same join.

The runner now drains final frames for 250ms after an actual child `exit`, then
releases the stdout reader. Reader completion rejects pending RPCs before the
join. The transport recognizes an already observed signal exit without waiting
again for `close`. Existing exit-code/error handling decides the outcome; a
completion marker does not override a nonzero process exit. No idle timeout,
heartbeat policy, run-state migration or background recovery service was added.
An alive process, even one producing no output, does not arm this drain timer.

The regression runs a real protocol-only Node app-server through the Codex
runner and workflow engine. A PassThrough deliberately withholds stdout EOF,
independent of Windows/POSIX inheritance differences. It covers autonomous
`quick-task`, a nudge followed by a final partial report and goal-close event,
successful and unsuccessful exit, persisted terminal state and retained report,
an active quiet turn, an ordinary turn-end accepting a follow-up, and unanswered
bootstrap. Without the source fix, the two
terminal-state tests remain `running` and bootstrap times out (3 failures,
exit 1); the live-turn guard still passes. With the fix, all five pass.

Verification on Windows:

- `npm test -- packages/cezar/src/workflows/codex-exit-finalization.test.ts packages/cezar/src/core/codex-app-server-transport.test.ts`
  — 16 passed, exit 0.
- `npm test -- packages/cezar/src/core/codex-app-server-runner.test.ts -t "SIGTERM"`
  — 4 passed, 11 unrelated tests filtered out, exit 0.
- `npm run typecheck:server` — exit 0, including test sources.
- `git diff --check` — exit 0. Full monorepo/package suites were intentionally
  not run for this runner-only change.

## Existing run and next diagnostic step

This patch does not repair an already pending Promise in the running cockpit.
The incident was not cancelled, continued, rewritten or recovered, and port
4321, its configuration and its processes were not changed. No restart,
deployment, push, merge or PR creation was performed.

For a future reproduction in an isolated cockpit using the same native Codex
binary, capture the root PID and separate timestamps for `exit`, stdout `end`,
`close`, bootstrap settlement and session-result settlement. Compare those
against the close intent and final assistant event. That is the minimal evidence
needed to confirm this mechanism for the historical incident; silence alone is
insufficient evidence for recovery or success.
