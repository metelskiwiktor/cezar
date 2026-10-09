import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The FULL final text of a graph agent node, kept beside the run (graph `outputs` keep only a
 * `NODE_SUMMARY_CAP` tail). Written for agent nodes whose text a later system node publishes
 * (`github.review-comment`), so a restart between the two still publishes the whole text.
 * Writes are atomic (tmp + rename); a read never throws.
 */
const SAFE = /^[A-Za-z0-9_-]+$/;

export function nodeTextPath(dataDir: string, runId: string, nodeId: string): string {
  if (!SAFE.test(runId) || !SAFE.test(nodeId)) throw new Error(`unsafe node text path: ${runId}/${nodeId}`);
  return join(dataDir, 'node-text', runId, `${nodeId}.md`);
}

export function writeNodeText(dataDir: string, runId: string, nodeId: string, text: string): void {
  const path = nodeTextPath(dataDir, runId, nodeId);
  mkdirSync(join(dataDir, 'node-text', runId), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function readNodeText(dataDir: string, runId: string, nodeId: string): string | undefined {
  try {
    return readFileSync(nodeTextPath(dataDir, runId, nodeId), 'utf8');
  } catch {
    return undefined;
  }
}
