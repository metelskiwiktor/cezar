import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRunSpec, AgentToolCallRecord } from './agent-runner.ts';

/** Narrow recovery for the observed module/index.ts -> module.ts discovery mistake.
 * Successful tool lifecycle events are evidence even when cortex omits result text.
 * Unknown errors, missing required files and paths outside the checkout never recover.
 */
export class AgyReviewEvidence {
  private readonly calls = new Map<string, AgentToolCallRecord>();
  private readonly pending = new Set<string>();
  private readonly reads = new Set<string>();
  private readonly recoveries = new Set<string>();
  private readonly required = new Set<string>();
  private diffRead = false;
  private validContext = false;
  private readonly diff: string | undefined;

  constructor(private readonly spec: AgentRunSpec) {
    this.diff = /(?:^|\n)The PR diff is: (git diff ([a-f0-9]{40}) ([a-f0-9]{40}))(?:\n|$)/.exec(spec.userPrompt)?.[1];
    if (!this.diff || !spec.cwd) return;
    const [, , base, head] = this.diff.split(' ');
    const git = (args: string[]) => spawnSync('git', args, { cwd: spec.cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const current = git(['rev-parse', 'HEAD']);
    const changed = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--diff-filter=d', base!, head!]);
    if (current.status !== 0 || current.stdout.trim() !== head || changed.status !== 0) return;
    this.required.add(resolve(spec.cwd, 'AGENTS.md'));
    for (const path of changed.stdout.split('\0').filter(Boolean)) this.required.add(resolve(spec.cwd, path));
    this.validContext = true;
  }

  call(record: AgentToolCallRecord): void {
    this.calls.set(record.id, record);
    this.pending.add(record.id);
  }

  private file(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || !this.spec.cwd) return;
    const path = (input as Record<string, unknown>).AbsolutePath;
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    const absolute = resolve(path);
    const local = relative(this.spec.cwd, absolute);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return;
    return absolute;
  }

  result(id: string, error: boolean, message: string): boolean {
    const call = this.calls.get(id);
    if (!call) return false;
    this.pending.delete(id);
    if (!error && call.name === 'run_command' && (call.input as Record<string, unknown>)?.CommandLine === this.diff) this.diffRead = true;
    if (call.name !== 'view_file') return false;
    const path = this.file(call.input);
    if (!path) return false;
    if (!error) {
      if (!existsSync(path)) return false;
      this.reads.add(path);
      // Only a subsequent read resolves the failed attempt.
      this.recoveries.delete(path);
      return false;
    }
    if (!/\bENOENT\b|The system cannot find (?:the path|the file) specified\.|no such file or directory/i.test(message)) return false;
    if (existsSync(path) || this.required.has(path)) return false;
    const extension = extname(path);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension) || !path.endsWith(`${sep}index${extension}`)) return false;
    this.recoveries.add(`${dirname(path)}${extension}`);
    return true;
  }

  complete(): boolean {
    return this.validContext && this.diffRead && this.pending.size === 0 && this.recoveries.size === 0 &&
      [...this.required].every((path) => existsSync(path) && this.reads.has(path));
  }

  get hasContext(): boolean { return this.diff !== undefined; }
}
