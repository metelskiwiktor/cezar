// Stand-in for the `agy` CLI in agy-hardening tests. Behavior is chosen by FAKE_AGY_MODE;
// it ignores agy's own argv. Never talks to the network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

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
    if (process.env.FAKE_AGY_OMIT !== 'correction') read('src/models.ts');
    if (process.env.FAKE_AGY_OMIT !== 'agents') read('AGENTS.md');
    if (process.env.FAKE_AGY_OMIT !== 'changed') read('tracked.txt');
    if (process.env.FAKE_AGY_OMIT !== 'diff') tool('run_command', { CommandLine: process.env.FAKE_AGY_DIFF });
    if (process.env.FAKE_AGY_MUTATE) tool('write_to_file', { TargetFile: 'tracked.txt' });
    if (process.env.FAKE_AGY_PENDING) line({ event: 'step_update', step_update: { step_index: ++id, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), 'tracked.txt') } } } });
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Findings: none. Reviewed AGENTS.md, the full diff and changed files; no correctness or regression issues found.\nRecommendation: APPROVE' } });
    break;
  }
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
