# Windows local validation

Notes for reading `npm test`, `npm run test:unit` and `npm run test:package` on native Windows
(recorded from the 2026-10-23 baseline and the PR #18 validation, which passed in CI).

| Test | Windows behavior | Cause |
| --- | --- | --- |
| `packages/cezar/test/unit/test-env-launcher.test.ts` | **skipped** with a reason | The launcher (`.ai/scripts/test-env-up.sh`) is a POSIX shell script and the test spawns `/bin/sh`, which native Windows lacks (`spawnSync /bin/sh ENOENT`). Runs on Linux, macOS and WSL; CI covers it. |
| `packages/cezar/test/e2e/package-cli.test.ts` | **runs** | Spawning `npm.cmd` directly fails with `spawn EINVAL` on current Node; the test now runs npm's `npm-cli.js` through `node` with an argument array (no shell). Its runtime-auth segment (a script used as `CEZ_CLAUDE_BIN`) is skipped on Windows, which cannot exec it directly; everything else runs. Needs `npm run build` first. |

Other failures in a full local vitest run on Windows (long runtime, timeouts under load) are not
covered here: they were not shown to be platform requirements. Treat them as load or real
regressions until reproduced in isolation (`npm test -- path/to/one.test.ts`), and compare with CI.

Unrelated unit failures seen locally on Windows (`team-skills` / `listRemoteSkills` in `test/unit`) are outside this note and were not investigated.
