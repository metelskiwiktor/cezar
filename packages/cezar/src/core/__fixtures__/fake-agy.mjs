// Stand-in for the `agy` CLI in agy-hardening tests. Behavior is chosen by FAKE_AGY_MODE;
// it ignores agy's own argv. Never talks to the network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (process.env.FAKE_AGY_ASSERT_PR_SCOPE) {
  const args = process.argv.slice(2);
  if (!args.includes('--disable-slash-commands') || !args.includes('--sandbox') ||
      args[args.indexOf('--mode') + 1] !== 'plan' || args.filter((v) => v === '--add-dir').length !== 1 ||
      args.at(-1).includes('MAIN_IMPLEMENTATION_SKILL') ||
      ['CEZ_HANDOFF_FILE', 'CEZ_TODOS_FILE', 'CEZ_TREE_DIR', 'CEZ_BIN'].some((key) => process.env[key])) {
    process.stderr.write('PR review leaked implementation context or external roots');
    process.exit(1);
  }
}

switch (mode) {
  case 'recovery': {
    let id = 0;
    const tool = (tool_name, parameters, error) => {
      const step_index = ++id;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: error ? 'ERROR' : 'DONE', step_type: 'tool', tool_name, tool_info: error ? { error } : { result: '' } } });
    };
    const read = (path, error) => tool('view_file', { AbsolutePath: join(process.cwd(), path) }, error);
    if (!process.env.FAKE_AGY_SKIP_ERROR) read(process.env.FAKE_AGY_MISSING_PATH ?? 'src/models/index.ts', process.env.FAKE_AGY_ERROR ?? 'GetFileAttributesEx: The system cannot find the path specified.');
    for (let n = 0; n < Number(process.env.FAKE_AGY_EXTRA_MISSES ?? 0); n++) read(`docs/optional${n}/README.md`, 'ENOENT: no such file or directory');
    if (process.env.FAKE_AGY_OMIT !== 'correction') read('src/models.ts');
    if (process.env.FAKE_AGY_OMIT !== 'agents') read('AGENTS.md');
    if (process.env.FAKE_AGY_OMIT !== 'changed') read('tracked.txt');
    if (process.env.FAKE_AGY_OMIT !== 'diff') tool('run_command', { CommandLine: process.env.FAKE_AGY_DIFF });
    if (process.env.FAKE_AGY_MUTATE) tool('write_to_file', { TargetFile: 'tracked.txt' });
    if (process.env.FAKE_AGY_PENDING) line({ event: 'step_update', step_update: { step_index: ++id, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), 'tracked.txt') } } } });
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Findings: none. Reviewed AGENTS.md, the full diff and changed files; no correctness or regression issues found.\nRecommendation: APPROVE' } });
    break;
  }
  case 'denial':
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), '..', 'denied.md') } } } });
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'view_file', tool_info: { error: 'permission check failed for read_file: user denied permission' } } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    line({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'attempt to bypass denial' } } } });
    break;
  case 'write':
    writeFileSync(join(process.cwd(), 'written-by-agent.txt'), 'ok\n');
    break;
  case 'hang':
    setInterval(() => {}, 1_000);
    break;
  case 'deltas':
    // One message streamed as deltas, the way agy streams `agent_response` text.
    for (const text_delta of ['Find', 'ings: no', 'ne.\n', 'Recommendation: ', 'APPROVE']) {
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } });
    }
    break;
  case 'fail':
    process.stderr.write('boom\n');
    process.exit(3);
    break;
  default:
    break;
}
if (mode !== 'hang') line({ type: 'noop' });
