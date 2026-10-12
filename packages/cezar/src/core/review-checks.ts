/** Cezar-owned, shell-free review checks. Repository tests are trusted local code,
 * not an OS sandbox: they run as the owner and may have side effects. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { killAgyTree } from './kill-process-tree.ts';
import { getWorkspaceGitSnapshot, verifyWorkspaceIntegrity } from './read-only-sandbox.ts';
import { z } from 'zod';

export const CHECK_MARKER = 'CEZ_REVIEW_CHECK ';
const reviewCheckSchema = z.object({
  args: z.array(z.string().max(500).regex(/^[^\r\n\0]*$/)).min(1).max(20),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export type ReviewCheck = z.infer<typeof reviewCheckSchema>;
export function parseReviewCheck(text: string): ReviewCheck | undefined {
  const response = text.trim();
  const lines = response.split('\n');
  if (!lines.some((line) => line.trimStart().startsWith(CHECK_MARKER))) return;
  if (lines.length !== 1 || !response.startsWith(CHECK_MARKER)) throw new Error('Invalid review check request');
  return reviewCheckSchema.parse(JSON.parse(response.slice(CHECK_MARKER.length)));
}

function git(cwd: string, args: string[]): string {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (p.error || p.status !== 0) throw new Error('Review checkout git inspection failed');
  return p.stdout;
}

export function pinnedReviewDiff(cwd: string, base: string, head: string): string {
  if (![base, head].every((v) => /^[a-f0-9]{40}$/.test(v)) || git(cwd, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('Invalid pinned review HEAD');
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Review checkout is dirty; use a fresh prepared PR worktree and preserve this one for diagnosis');
  // Disable config-controlled external diff/textconv programs. Never truncate silently.
  return git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, head]);
}

/** A checkout-local file avoids the Windows argv limit. It is machine-owned,
 * never overwrites a repository file, and is removed on every session exit. */
export function prepareReviewDiff(cwd: string, base: string, head: string) {
  const diff = pinnedReviewDiff(cwd, base, head);
  const root = join(cwd, '.cezar-review-tmp');
  const created = !existsSync(root);
  if (!created && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) throw new Error('Unsafe review artifact root');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'diff-'));
  const rootActual = realpathSync(root);
  const dirActual = realpathSync(dir);
  const file = join(dir, 'full.diff');
  const runtimeDir = join(dir, 'runtime');
  mkdirSync(runtimeDir);
  try { writeFileSync(file, diff, { encoding: 'utf8', flag: 'wx' }); }
  catch (err) { rmSync(dir, { recursive: true, force: true }); if (created) rmdirSync(root); throw err; }
  const lines = (text: string) => Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  return { file, runtimeDir, lines: lines(diff), resultFile: (n: number, result: string) => {
    if (realpathSync(dir) !== dirActual) throw new Error('Review artifact directory changed');
    const path = join(dir, `check-${n}.txt`);
    writeFileSync(path, result, { encoding: 'utf8', flag: 'wx' });
    return { path, lines: lines(result) };
  }, cleanup: () => {
    // Fixed machine-created directory; never traverse user-supplied cleanup paths.
    if (realpathSync(root) !== rootActual || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dirActual) throw new Error('Unsafe review artifact cleanup refused');
    rmSync(dir, { recursive: true, force: true });
    if (created) { try { rmdirSync(root); } catch { /* leave other artifacts for diagnosis */ } }
  } };
}

function localPath(cwd: string, path: string, allowSharedDependency = false): boolean {
  if (!path || path.startsWith('-') || isAbsolute(path) || /[\\:;|&<>`$\r\n]/.test(path)) return false;
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (!existsSync(abs)) return false;
  const actual = relative(realpathSync(cwd), realpathSync(abs));
  if (actual !== '..' && !actual.startsWith(`..${sep}`) && !isAbsolute(actual)) return true;
  return allowSharedDependency && sharedDependencyPath(cwd, abs);
}

const lockSchema = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) });
const packageSchema = z.object({ version: z.string() });
/** No extra Agy workspace grant. Only Cezar's rg can inspect a shared public
 * dependency through the checkout alias, from THIS Git repo's main cache,
 * with the requested package version matching the pinned checkout lockfile. */
function sharedDependencyPath(cwd: string, abs: string): boolean {
  const parts = relative(cwd, abs).split(sep);
  if (parts[0] !== 'node_modules') return false;
  try {
    const common = resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim());
    if (!common.endsWith(`${sep}.git`)) return false;
    const cache = realpathSync(join(dirname(common), 'node_modules'));
    if (realpathSync(join(cwd, 'node_modules')) !== cache) return false;
    const inside = (p: string) => {
      const rel = relative(cache, realpathSync(p));
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    if (!inside(abs)) return false; // Reject nested links into host/private files.
    const index = parts.lastIndexOf('node_modules');
    const name = parts[index + 1];
    if (!name) return false;
    const packageParts = parts.slice(0, index + (name.startsWith('@') ? 3 : 2));
    const manifest = join(cwd, ...packageParts, 'package.json');
    const lock = join(cwd, 'package-lock.json');
    if (!inside(manifest) || !lstatSync(lock).isFile() || lstatSync(lock).size > 8 * 1024 * 1024 || lstatSync(manifest).size > 1024 * 1024) return false;
    const expected = lockSchema.parse(JSON.parse(readFileSync(lock, 'utf8'))).packages[packageParts.join('/')]?.version;
    const installed = packageSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))).version;
    return expected !== undefined && expected === installed;
  } catch { return false; }
}

export function reviewCommand(cwd: string, args: string[]): [string, string[]] {
  if (args.length > 20 || args.some((a) => a.length > 500 || /[\r\n\0]/.test(a))) throw new Error('Review command rejected');
  const [bin, action, ...rest] = args;
  const path = rest[0];
  if (bin === 'git' && action === 'diff' && rest.length === 2 && rest.every((v) => /^[a-f0-9]{40}$/.test(v))) return ['git', ['diff', '--no-ext-diff', '--no-textconv', ...rest]];
  if (bin === 'git' && action === 'diff' && rest[0] === '--stat' && rest.length === 3 && rest.slice(1).every((v) => /^[a-f0-9]{40}$/.test(v))) return ['git', ['diff', '--no-ext-diff', '--no-textconv', '--stat', ...rest.slice(1)]];
  if (bin === 'git' && action === 'log' && rest.length === 0) return ['git', ['log', '--oneline', '-20']];
  if (bin === 'git' && action === 'grep' && rest.length === 2 && rest[0] !== undefined && rest[1] && localPath(cwd, rest[1])) return ['git', ['grep', '-n', '-e', rest[0], '--', rest[1]]];
  if (bin === 'rg' && action && !action.startsWith('-') && !/[\r\n]/.test(action) && rest.length === 1 && path && localPath(cwd, path, true)) return ['rg', ['-n', '--', action, path]];
  if (bin === 'just' && ((action === 'check' && rest.length === 0) || (action === 'test' && rest.length === 0) ||
      (action === 'test' && rest[0] === 'file' && rest.length > 1 && rest.slice(1).every((p) => localPath(cwd, p))))) return ['just', [action, ...rest]];
  if (bin === 'just' && ['flow', 'device', 'scenario'].includes(action ?? '')) throw new Error('UI/emulator check unavailable: resource authorization is required; report skipped');
  throw new Error('Review command rejected: use git diff/log/grep, rg pattern local-path, just check, just test [file local-path...]');
}

// Only NEW files in these narrowly named artifact roots can be removed. Existing
// files, tracked files (even ignored), source changes and symlinks fail closed.
const ARTIFACT = /^(?:coverage|\.cache|\.cezar-review-tmp)\//;
function files(cwd: string): Map<string, string> {
  const paths = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const ignored = git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.', ':(exclude)node_modules', ':(exclude)**/node_modules/**']).split('\0').filter(Boolean);
  return new Map([...new Set([...paths, ...ignored])].map((p) => {
    const abs = resolve(cwd, p);
    return [p, !existsSync(abs) ? 'missing' : lstatSync(abs).isSymbolicLink() ? 'symlink' : createHash('sha256').update(readFileSync(abs)).digest('hex')];
  }));
}

export function reviewSourceFingerprint(cwd: string): string {
  return JSON.stringify([...files(cwd)].sort(([a], [b]) => a.localeCompare(b)));
}

export async function executeReviewCheck(cwd: string, request: ReviewCheck, env: NodeJS.ProcessEnv, timeoutMs: number,
  onChild?: (child: ChildProcessWithoutNullStreams) => void): Promise<string> {
  if (request.args[0] === 'just' && ['flow', 'device', 'scenario'].includes(request.args[1] ?? '')) return 'UI/emulator check skipped: no separate resource authorization; no device was started.';
  const [bin, args] = reviewCommand(cwd, request.args);
  if (timeoutMs <= 0) throw new Error('Review command budget exhausted');
  const before = files(cwd);
  const snapshot = getWorkspaceGitSnapshot(cwd);
  if (snapshot === undefined) throw new Error('Review checkout snapshot unavailable');
  const tracked = new Set(git(cwd, ['ls-files', '-z']).split('\0'));
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const started = Date.now();
  const child = spawn(bin, args, { cwd, env, windowsHide: true, shell: false });
  onChild?.(child);
  let output = '';
  let outputBytes = 0;
  let timedOut = false;
  let tooLarge = false;
  const capture = (buf: Buffer) => {
    outputBytes += buf.length;
    if (outputBytes > 1024 * 1024) { tooLarge = true; killAgyTree(child); }
    else output += buf.toString('utf8');
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const timer = setTimeout(() => { timedOut = true; killAgyTree(child); }, Math.max(1, Math.min(timeoutMs, 5 * 60_000) - (Date.now() - started)));
  let status: number | null = null;
  let error: Error | undefined;
  try {
    status = await new Promise<number | null>((done) => {
      child.once('error', (e) => { error = e; done(null); });
      child.once('close', done);
    });
  } finally {
    clearTimeout(timer);
    const after = files(cwd);
    const violations: string[] = [];
    for (const [path, hash] of after) {
      if (before.get(path) === hash) continue;
      if (!before.has(path) && !tracked.has(path) && ARTIFACT.test(path) && hash !== 'symlink' && localPath(cwd, path)) rmSync(resolve(cwd, path));
      else violations.push(path);
    }
    for (const path of before.keys()) if (!after.has(path)) violations.push(path);
    if (git(cwd, ['rev-parse', 'HEAD']) !== head || violations.length || !verifyWorkspaceIntegrity(cwd, snapshot).clean) throw new Error(`Review source integrity violation: ${violations.join(', ') || 'git state changed'}`);
  }
  if (timedOut) throw new Error('Review command timed out; process tree stopped');
  if (tooLarge) throw new Error('Review command output budget exceeded; no truncated evidence accepted');
  if (error) return `Command unavailable (${error.message}); report this check as skipped.`;
  return `Check: ${request.args.join(' ')}\nReason: ${request.reason}\nExit: ${status}; duration: ${Date.now() - started}ms\n${output}`;
}
