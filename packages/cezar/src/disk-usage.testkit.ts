import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Measure with the real system tool; missing du is the documented null case. */
export async function expectedDiskUsage(path: string): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await run('du', ['-sk', path], { encoding: 'utf8' }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const match = /^(\d+)\s/.exec(stdout);
  assert.ok(match, `du must report a kibibyte count: ${stdout}`);
  const bytes = Number(match[1]) * 1024;
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, 'fixture must occupy disk space');
  return bytes;
}
