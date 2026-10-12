import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
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
  private optionalMisses = 0;
  private readonly diff: string | undefined;
  private trustedDiff = false;
  private diffFile: string | undefined;
  private diffLines = 0;
  private readonly diffCoverage = new Set<number>();
  private readonly checkFiles = new Map<string, { lines: number; coverage: Set<number> }>();
  private readonly affected = new Set<string>();

  constructor(private readonly spec: AgentRunSpec) {
    const base = spec.prReview?.mergeBase;
    const head = spec.prReview?.headSha;
    if (!base || !head || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head) || !spec.cwd) return;
    this.diff = `git diff ${base} ${head}`;
    const git = (args: string[]) => spawnSync('git', args, { cwd: spec.cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const current = git(['rev-parse', 'HEAD']);
    const changed = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--diff-filter=d', base, head]);
    const stats = git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', base, head]);
    if (current.status !== 0 || current.stdout.trim() !== head || changed.status !== 0 || stats.status !== 0) return;
    const binary = new Set(stats.stdout.split('\0').filter((row) => row.startsWith('-\t-\t')).map((row) => row.slice(4)));
    this.required.add(resolve(spec.cwd, 'AGENTS.md'));
    for (const path of changed.stdout.split('\0').filter(Boolean)) {
      this.required.add(resolve(spec.cwd, path));
      if (!binary.has(path) && existsSync(resolve(spec.cwd, path)) && lstatSync(resolve(spec.cwd, path)).isFile()) this.affected.add(resolve(spec.cwd, path));
    }
    this.validContext = true;
  }

  call(record: AgentToolCallRecord): void {
    this.calls.set(record.id, record);
    this.pending.add(record.id);
  }

  /** Only the runner may record successful delivery of Cezar's bounded full diff. */
  deliverTrustedDiff(file: string, lines: number): void {
    this.trustedDiff = true;
    this.diffFile = resolve(file);
    this.diffLines = lines;
  }
  requireCheckResult(file: string, lines: number): void { this.checkFiles.set(resolve(file), { lines, coverage: new Set() }); }

  private file(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || !this.spec.cwd) return;
    const params = input as Record<string, unknown>;
    const path = params.AbsolutePath ?? params.DirectoryPath ?? params.SearchPath ?? params.SearchDirectory ?? params.File;
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    const absolute = resolve(path);
    const local = relative(this.spec.cwd, absolute);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return;
    // A lexically local path can still traverse a checkout symlink/junction.
    // Resolve its nearest existing ancestor, including for optional missing files.
    let ancestor = absolute;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    try {
      const actual = relative(realpathSync(this.spec.cwd), realpathSync(ancestor));
      if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) return;
    } catch { return; }
    return absolute;
  }

  allowsFileInspection(record: AgentToolCallRecord): boolean {
    return !['view_file', 'view_file_outline', 'view_code_item', 'grep_search', 'list_dir', 'find_by_name'].includes(record.name.toLowerCase()) || this.file(record.input) !== undefined;
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
      if (this.trustedDiff && path === this.diffFile) {
        const input = call.input as Record<string, unknown>;
        const start = input.StartLine;
        const end = input.EndLine;
        // Never infer completeness from a provider's default/truncated read.
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number(start) >= 1 &&
            Number(end) >= Number(start) && Number(end) - Number(start) < 500) {
          for (let n = Number(start); n <= Math.min(Number(end), this.diffLines); n++) this.diffCoverage.add(n);
        }
        this.diffRead = this.diffCoverage.size === this.diffLines;
      }
      const check = this.checkFiles.get(path);
      if (check) {
        const input = call.input as Record<string, unknown>;
        const start = Number(input.StartLine);
        const end = Number(input.EndLine);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end - start < 500) {
          for (let n = start; n <= Math.min(end, check.lines); n++) check.coverage.add(n);
        }
      }
      // Only a subsequent read resolves the failed attempt.
      this.recoveries.delete(path);
      return false;
    }
    if (!/\bENOENT\b|The system cannot find (?:the path|the file) specified\.|no such file or directory/i.test(message)) return false;
    if (existsSync(path) || this.required.has(path)) return false;
    // Only a known optional checkout README, never an arbitrary missing source,
    // skill or external handoff. Success still requires the diff + all required reads.
    const local = relative(this.spec.cwd, path);
    if (basename(path) === 'README.md' && (local === 'README.md' || local.startsWith(`docs${sep}`)) && this.optionalMisses < 2) {
      this.optionalMisses++;
      return true;
    }
    const extension = extname(path);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension) || !path.endsWith(`${sep}index${extension}`)) return false;
    this.recoveries.add(`${dirname(path)}${extension}`);
    return true;
  }

  complete(): boolean {
    const cwd = this.spec.cwd;
    if (!cwd) return false;
    return this.validContext && this.diffRead && this.pending.size === 0 && this.recoveries.size === 0 &&
      [...this.checkFiles.values()].every((check) => check.coverage.size === check.lines) &&
      (this.trustedDiff
        ? this.reads.has(resolve(cwd, 'AGENTS.md')) &&
          (this.affected.size === 0 || [...this.affected].some((path) => this.reads.has(path)))
        : [...this.required].every((path) => existsSync(path) && this.reads.has(path)));
  }

  get hasContext(): boolean { return this.spec.prReview !== undefined || this.spec.userPrompt.includes('The PR diff is:'); }
}
