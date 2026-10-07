// Child process for the two-process lease contention tests in store.test.ts (#998).
// `.testkit.ts` keeps it out of `tsconfig.json`'s build input, so this test-only
// entry point never reaches `dist` or the published tarball.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import gfs from 'graceful-fs';
import { AutomationStore } from './store.ts';

const dir = process.argv[2]!;
const barriers = process.argv[3];
const role = process.argv[4];

if (barriers && role) {
  mkdirSync(barriers, { recursive: true });
  const sleep = (ms: number) => {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  };
  const signal = (name: string) => writeFileSync(`${barriers}/${name}`, '');
  const wait = (name: string) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${barriers}/${name}`)) {
      if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
      sleep(2);
    }
  };
  const gates: Record<string, () => void> = role === 'a'
    ? {
        'stat:1': () => { signal('a1'); wait('b1'); },
        'mkdir:2': () => { signal('a2'); wait('b2'); },
        'utimes:1': () => { signal('a3'); wait('b3'); },
        'rmdir:2': () => signal('a4'),
      }
    : {
        'stat:1': () => { signal('b1'); wait('a2'); },
        'rmdir:1': () => { signal('b2'); wait('a3'); },
        'mkdir:2': () => { signal('b3'); wait('a4'); },
      };
  const counts: Record<string, number> = {};
  for (const method of ['mkdir', 'rmdir', 'stat', 'utimes'] as const) {
    const original = gfs[`${method}Sync`];
    gfs[`${method}Sync`] = ((target: Parameters<typeof original>[0], ...rest: unknown[]) => {
      if (typeof target !== 'string' || !target.endsWith('.guard')) return original(target, ...rest);
      const nth = (counts[method] = (counts[method] ?? 0) + 1);
      let thrown: unknown;
      let value: unknown;
      try { value = original(target, ...rest); } catch (error) { thrown = error; }
      gates[`${method}:${nth}`]?.();
      if (thrown) throw thrown;
      return value;
    }) as typeof original;
  }
}

const store = AutomationStore.open(dir);
process.stdout.write('ready\n');
let started = false;
process.stdin.once('data', () => {
  if (started) return;
  started = true;
  const lease = store.acquireLease();
  process.stdout.write(`${JSON.stringify({ held: Boolean(lease) })}\n`);
  setTimeout(() => lease?.release(), 1_000);
});
