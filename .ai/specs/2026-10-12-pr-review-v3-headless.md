# PR review V3: Windows headless checks

The #35 review of Tabnote failed after Cezar #5 (`fbebd75c`): Agy plan mode
required a full `git diff`, but `--sandbox` required unavailable Windows process
security environments (Windows 11 24H2 plus the August 2026 update). Retrying
unsandboxed hit `permission check failed ... user denied permission`. Neither
retrying a denial nor merely deleting `--sandbox` supplies a usable command path.

## Mechanism

Keep Agy `--mode plan --disable-slash-commands`, checkout-only `--add-dir`, no
global/implementation skills or journal prompt, and stripped publication env.
Do not enable `--dangerously-skip-permissions`: local `agy --help` documents that
it auto-approves **all** tool permission requests, not just review commands.

Cezar executes the pinned full diff with fixed Git argv, disabling external diff
and textconv. A unique machine-owned `.cezar-review-tmp/diff-*/full.diff` avoids
Windows command-line length limits. It is removed on success, failure or cancel.
The reviewer must successfully inspect every line using explicit view ranges
(at most 500 lines), AGENTS.md, and affected checkout code. Generated/binary
files need analysis of their full patch/metadata, not ritual per-file tool calls.
Evidence never accepts an absent, partial or pending diff read, forged task SHA,
missing AGENTS.md, unresolved discovery error or no affected-file inspection.
Successful provider lifecycle events establish delivery, not proof of cognition.

A reviewer can finish a turn with one justified `CEZ_REVIEW_CHECK` JSON request.
Cezar validates an argv array before spawning a normal process, without a shell:

- `git diff [--stat] <sha> <sha>` (external diff/textconv disabled), `git log` (20 commits), `git grep <pattern> <existing checkout path>`.
- `rg <pattern> <existing checkout path>` (no option injection).
- `just check`, `just test`, `just test file <existing checkout paths...>`.

No installs, arbitrary command flags, shell composition, push/commit/merge,
GitHub publication or OTA/EAS commands. Native Agy terminal/unknown tools fail
the review; the stream tripwire is **post-execution**, not an OS permission
boundary. Native permission denials remain fatal, with the original error in
the log; there is no retry or fallback after a denial.

Check results include reason, exit status, duration and bounded output, stored
in checkout-local machine-owned result files (also removed on exit). A fresh
Agy turn receives their paths and must inspect all result lines before finalizing;
large outputs never inflate Windows argv. It also receives prior requests. Only
the conversation ID emitted by this review's initial CLI session may be resumed
between checks; incoming implementation/previous-review session IDs are ignored.
This preserves pending findings without importing handoff or global history. Only
the final review is emitted as publishable text. At most six commands, five
minutes each, within one cumulative review timeout. Output above 1 MiB fails;
full diff above the 8 MiB transport bound fails rather than truncating. An
unavailable executable is reported as skipped, not passed. UI/emulator requests
are skipped without provisioning anything: separate resource authorization is
required before a future executor can admit them. Agy chooses proportionate
checks; no automatic full test suite or emulator per review.

## Integrity and limits

Cezar hashes tracked and untracked checkout files, including ignored files
except dependency trees (`node_modules`), and compares Git state and HEAD.
Initial dirty checkouts are rejected. A session-wide baseline is checked again
after removing machine-owned artifacts, covering drift between check/CLI rounds.
Only **new** files under `coverage/`, `.cache/`, `.cezar-review-tmp/` can be
removed after a trusted check. Existing files in those roots, tracked files,
source/snapshot changes, symlinks and all other new files fail review. Changes
are not silently reverted. Failure preserves offending files for diagnosis;
normal isolated-worktree lifecycle cleanup remains the owner's responsibility.
The runner verifies file hashes around native inspection turns as well.
Common TEMP/TMP/TMPDIR, XDG and npm caches are redirected to the reviewer-owned
scratch directory; CI mode avoids automatic snapshot creation. This is a
convention for cooperative tools, not confinement of repository test code.

For Tabnote's shared dependency symlink, the reviewer uses Cezar `rg` on a
`node_modules/package/...` alias. Its target must be this Git repository's main
`node_modules` cache, the file and manifest must stay inside that cache, and the
package version must match the checkout lockfile. Nested links into private host
files, mismatched versions and arbitrary outside paths fail. This grants no
native Agy external file permission or extra `--add-dir`; shared library tests
are not admitted through the file-test command. Direct checkout dependencies
remain readable as ordinary checkout files.

Git/GitHub config isolation and credential env stripping remain; executor env
also removes Agy/Google/Gemini and cockpit credentials/context. Publication
remains exclusively `github.review-comment`, with the existing local-path
validator, succeeded-step requirement, pinned HEAD gate and one-comment dedup.

This is **logical local-owner isolation**, not an OS sandbox. Repository tests
and just recipes are executable checkout code and run as the owner. They can
read host files, invoke child processes/network, mutate dependency caches or
write outside the worktree; source hashes cannot prevent transient or external
effects. Scope checks and tool tripwires detect violations but cannot undo a
completed native tool. Do not use this mode for hostile third-party PRs without
an OS/container boundary. No new claim of filesystem ACL confinement is made.
Existing Agy file-access permission checks are retained. If they demand approval
on an installation, fail clearly; do not auto-approve or bypass it.

## Verification and post-merge smoke

Offline mock Agy supplies successful file lifecycles and check requests; Cezar
runs real Git and just fixture commands on Windows. Tests cover legacy exebox
and unsandboxed denial, args, evidence, budgets/timeouts, temp artifact cleanup,
source mutation, command/path rejection, absent resources, credentials and the
unchanged publication gates. No live Agy model call, API charge, Tabnote review
or test PR is used. Local CLI help proves flag availability only, not a real
Antigravity model's adherence to the protocol or headless file permissions.

After owner-managed merge and restart/deploy of the new Cezar, manually launch
one review of the still-open Tabnote #35 at its current pinned HEAD. Inspect
events: checkout-only plan args without sandbox/permission bypass; all full-diff
ranges and AGENTS.md read; a justified targeted check returns exit/duration;
emulator skipped unless separately authorized. Check source integrity, exactly
one final recommendation and one trusted review comment for that HEAD. Repeating
the same HEAD must dedup; a changed HEAD must suppress stale publication. Any
native approval denial is a stop condition with its original diagnostic. This
smoke is pending deployment and is not claimed by the offline fixture tests.
