// Protocol-only app-server; the test retains its stdout reader after exit.
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const exit = (code) => {
  process.stdout.end(() => process.exit(code));
};
const rl = createInterface({ input: process.stdin });
let turns = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (mode === 'bootstrap') return exit(1);
    emit({ id: msg.id, result: {} });
  } else if (msg.method === 'thread/start') {
    emit({ id: msg.id, result: { thread: { id: 'retained-stdout' } } });
  } else if (msg.method === 'turn/start') {
    const id = `turn-${++turns}`;
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'turn/started', params: { turn: { id } } });
    const text = turns === 1 ? 'Working on the task.' : 'Partial spike report.\n\nCEZ:DONE';
    emit({ method: 'item/completed', params: { item: { id: `message-${turns}`, type: 'agentMessage', text } } });
    if (mode !== 'live') emit({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
  }
});
rl.on('close', () => exit(mode === 'error' ? 1 : 0));
