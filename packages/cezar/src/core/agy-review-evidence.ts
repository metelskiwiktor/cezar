import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRunSpec, AgentToolCallRecord } from './agent-runner.ts';
import type { ReviewDiffPart } from './review-checks.ts';

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
  private readonly diffParts = new Map<string, number>();
  private readonly partsRead = new Set<string>();
  private readonly diffCoverage = new Set<number>();
  private readonly checkFiles = new Map<string, { lines: number; read: boolean; coverage: Set<number> }>();
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
    const agentsPath = resolve(spec.cwd, 'AGENTS.md');
    if (existsSync(agentsPath)) {
      this.required.add(agentsPath);
    }
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
  deliverTrustedDiff(file: string, lines: number, parts?: ReviewDiffPart[]): void {
    this.trustedDiff = true;
    this.diffFile = resolve(file);
    this.diffLines = lines;
    this.diffParts.clear();
    this.partsRead.clear();
    this.diffCoverage.clear();
    if (parts && parts.length > 0) {
      for (const p of parts) this.diffParts.set(resolve(p.file), p.lines);
    } else {
      this.diffParts.set(resolve(file), lines);
    }
  }

  requireCheckResult(file: string, lines: number): void {
    this.checkFiles.set(resolve(file), { lines, read: false, coverage: new Set() });
  }

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
      if (this.trustedDiff) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        const start = input.StartLine !== undefined ? Number(input.StartLine) : undefined;
        const end = input.EndLine !== undefined ? Number(input.EndLine) : undefined;
        const hasRange = start !== undefined && end !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start;

        // 1. Check if the read was on full.diff:
        if (path === this.diffFile) {
          if (!hasRange) {
            // Unranged view_file: provider delivers up to 800 lines.
            // If the whole file has <= 800 lines, 100% of the diff is delivered.
            if (this.diffLines <= 800) {
              for (let n = 1; n <= this.diffLines; n++) this.diffCoverage.add(n);
              this.diffRead = true;
            } else {
              for (let n = 1; n <= Math.min(800, this.diffLines); n++) this.diffCoverage.add(n);
            }
          } else {
            for (let n = start!; n <= Math.min(end!, this.diffLines); n++) this.diffCoverage.add(n);
            if (this.diffCoverage.size >= this.diffLines) {
              this.diffRead = true;
            }
          }
        }

        // 2. Check if the read was on a split diff part:
        const partLines = this.diffParts.get(path);
        if (partLines !== undefined) {
          if (!hasRange) {
            if (partLines <= 800) this.partsRead.add(path);
          } else if (start! === 1 && end! >= partLines) {
            this.partsRead.add(path);
          }
          if (this.diffParts.size > 0 && this.partsRead.size === this.diffParts.size) {
            this.diffRead = true;
          }
        }
      }

      const check = this.checkFiles.get(path);
      if (check) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        const start = input.StartLine !== undefined ? Number(input.StartLine) : undefined;
        const end = input.EndLine !== undefined ? Number(input.EndLine) : undefined;
        const hasRange = start !== undefined && end !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start;
        if (!hasRange) {
          if (check.lines <= 800) {
            check.read = true;
            for (let n = 1; n <= check.lines; n++) check.coverage.add(n);
          } else {
            for (let n = 1; n <= Math.min(800, check.lines); n++) check.coverage.add(n);
          }
        } else {
          for (let n = start!; n <= Math.min(end!, check.lines); n++) check.coverage.add(n);
          if (check.coverage.size >= check.lines) {
            check.read = true;
          }
        }
      }

      // Only a subsequent read resolves the failed attempt.
      this.recoveries.delete(path);
      return false;
    }
    if (!/\bENOENT\b|The system cannot find (?:the path|the file) specified\.|no such file or directory/i.test(message)) return false;
    if (existsSync(path) || this.required.has(path)) return false;
    // Only a known optional checkout doc, never an arbitrary missing source,
    // skill or external handoff. Success still requires the diff + all required reads.
    const local = relative(this.spec.cwd, path);
    const localNormalized = local.replace(/\\/g, '/');
    const extension = extname(path);
    if ((local === 'README.md' || local === 'AGENTS.md' || (localNormalized.startsWith('docs/') && (extension === '.md' || extension === ''))) && this.optionalMisses < 2) {
      this.optionalMisses++;
      return true;
    }
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    if (!codeExtensions.includes(extension)) return false;
    if (path.endsWith(`${sep}index${extension}`)) {
      this.recoveries.add(`${dirname(path)}${extension}`);
      return true;
    }
    const dot = local.lastIndexOf('.');
    if (dot > 0) {
      const stem = path.slice(0, path.length - extension.length);
      for (const alt of codeExtensions) {
        if (alt !== extension && existsSync(`${stem}${alt}`)) {
          this.recoveries.add(`${stem}${alt}`);
          return true;
        }
      }
    }
    return false;
  }

  complete(): boolean {
    const cwd = this.spec.cwd;
    if (!cwd) return false;
    // An unresolved guessed path (`recoveries`) no longer voids the review: only the mandatory
    // evidence below does. `recoveries` still decides the stricter late-format-error path.
    const agentsPath = resolve(cwd, 'AGENTS.md');
    const agentsRead = !existsSync(agentsPath) || this.reads.has(agentsPath);
    return this.validContext && this.diffRead && this.pending.size === 0 &&
      [...this.checkFiles.values()].every((check) => check.read || check.coverage.size >= check.lines) &&
      (this.trustedDiff
        ? agentsRead &&
          (this.affected.size === 0 || [...this.affected].some((path) => this.reads.has(path)))
        : [...this.required].every((path) => existsSync(path) && this.reads.has(path)));
  }

  /** `complete()` plus every guessed path corrected — the late-format-error recovery's bar. */
  strictComplete(): boolean {
    return this.complete() && this.recoveries.size === 0;
  }

  get hasContext(): boolean { return this.spec.prReview !== undefined || this.spec.userPrompt.includes('The PR diff is:'); }
}
