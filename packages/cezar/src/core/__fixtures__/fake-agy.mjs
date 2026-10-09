// Stand-in for the `agy` CLI in agy-hardening tests. Behavior is chosen by FAKE_AGY_MODE;
// it ignores agy's own argv. Never talks to the network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

switch (mode) {
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
