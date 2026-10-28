/** Cezar-owned, shell-free review checks. Repository tests are trusted local code,
 * not an OS sandbox: they run as the owner and may have side effects. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { killAgyTree } from './kill-process-tree.ts';
import { READ_ONLY_PUSH_URL } from './read-only-sandbox.ts';
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
  // Disable config-controlled external diff/textconv programs. Never truncate silently.
  return git(cwd, ['diff', '--no-ext-diff', '--no-textconv', base, head]);
}

export interface ReviewDiffPart {
  file: string;
  lines: number;
}

export const CHUNK_MAX_LINES = 500;
export const CHUNK_MAX_BYTES = 32_000;

export function splitTextChunks(text: string, maxLines = CHUNK_MAX_LINES, maxBytes = CHUNK_MAX_BYTES): string[] {
  const lines = text.split('\n');
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return [text];
  }
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (current.length > 0 && (current.length >= maxLines || currentBytes + lineBytes > maxBytes)) {
      chunks.push(current.join('\n') + '\n');
      current = [line];
      currentBytes = lineBytes;
    } else {
      current.push(line);
      currentBytes += lineBytes;
    }
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }
  return chunks;
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
  // Runtime dir is placed in OS tmpdir so child tests never inherit .ai/cezar/worktrees in TMPDIR:
  const runtimeDir = mkdtempSync(join(tmpdir(), 'cez-check-rt-'));
  const runtimeDirActual = realpathSync(runtimeDir);
  try { writeFileSync(file, diff, { encoding: 'utf8', flag: 'wx' }); }
  catch (err) {
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    if (created) rmdirSync(root);
    throw err;
  }
  const lines = (text: string) => Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  const totalLines = lines(diff);
  const chunks = splitTextChunks(diff, CHUNK_MAX_LINES, CHUNK_MAX_BYTES);
  const parts: ReviewDiffPart[] = [];
  if (chunks.length <= 1) {
    parts.push({ file, lines: totalLines });
  } else {
    for (let i = 0; i < chunks.length; i++) {
      const partFile = join(dir, `diff-part-${i + 1}.diff`);
      writeFileSync(partFile, chunks[i]!, { encoding: 'utf8', flag: 'wx' });
      parts.push({ file: partFile, lines: lines(chunks[i]!) });
    }
  }
  return {
    file,
    parts,
    runtimeDir,
    lines: totalLines,
    resultFile: (n: number, result: string) => {
      if (realpathSync(dir) !== dirActual) throw new Error('Review artifact directory changed');
      const path = join(dir, `check-${n}.txt`);
      writeFileSync(path, result, { encoding: 'utf8', flag: 'wx' });
      return { path, lines: lines(result) };
    },
    /** Text Cezar read from the checkout for a path the backend refuses (relative form). */
    servedReadFile: (n: number, text: string) => {
      if (realpathSync(dir) !== dirActual) throw new Error('Review artifact directory changed');
      const path = join(dir, `read-${n}.txt`);
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
      return { path, lines: lines(text) };
    },
    cleanup: () => {
      try {
        if (existsSync(runtimeDir) && realpathSync(runtimeDir) === runtimeDirActual) {
          rmSync(runtimeDir, { recursive: true, force: true });
        }
      } catch { /* best-effort cleanup */ }
      if (realpathSync(root) !== rootActual || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dirActual) throw new Error('Unsafe review artifact cleanup refused');
      rmSync(dir, { recursive: true, force: true });
      if (created) { try { rmdirSync(root); } catch { /* leave other artifacts for diagnosis */ } }
    },
  };
}

/** A harmless request Cezar does not run as written: unsupported syntax, a check this checkout
 * does not provide, a path that does not exist. NOT fatal — the reviewer gets the reason and the
 * accepted forms back as the check result and may correct the request within its budget.
 * Anything that could escape the checkout, mutate it or publish stays a plain (fatal) Error. */
export class ReviewCheckRejected extends Error {}

function refuse(reason: string): never { throw new Error(`Review command refused: ${reason}`); }

/** A checkout-relative path, validated lexically AND through realpath. Missing or malformed
 * paths are rejected (non-fatal); anything pointing outside the checkout is fatal. */
function checkoutPath(cwd: string, path: string, allowSharedDependency = false): string {
  if (!path || path.startsWith('-')) throw new ReviewCheckRejected(`"${path}" is not a local path`);
  if (isAbsolute(path) || /[:;|&<>`$\r\n\0]/.test(path)) refuse(`"${path}" is not a checkout-relative path`);
  if (path.includes('\\')) throw new ReviewCheckRejected(`use forward slashes in "${path}"`);
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) refuse(`"${path}" escapes the checkout`);
  if (!existsSync(abs)) throw new ReviewCheckRejected(`"${path}" does not exist in the checkout`);
  const actual = relative(realpathSync(cwd), realpathSync(abs));
  if (actual !== '..' && !actual.startsWith(`..${sep}`) && !isAbsolute(actual)) return path;
  if (allowSharedDependency && sharedDependencyPath(cwd, abs)) return path;
  return refuse(`"${path}" resolves outside the checkout`);
}

function localPath(cwd: string, path: string): boolean {
  try { checkoutPath(cwd, path); return true; } catch { return false; }
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

/** What the prepared checkout offers, read from its ROOT justfile and package.json only: a
 * monorepo's package-level scripts are never guessed. Reads files, never executes anything. */
export interface ReviewCapabilities {
  /** Recipe name -> whether it declares parameters. Absent: the checkout has no justfile. */
  justRecipes?: Map<string, boolean>;
  /** The exposed scripts (`NPM_SCRIPTS`) the root package.json really declares. */
  npmScripts: Set<string>;
}

const NPM_SCRIPTS: readonly string[] = ['test', 'check', 'typecheck'];

function smallFile(path: string, maxBytes: number): string | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= maxBytes ? readFileSync(path, 'utf8') : undefined;
  } catch { return undefined; }
}

export function detectReviewCapabilities(cwd: string): ReviewCapabilities {
  const caps: ReviewCapabilities = { npmScripts: new Set() };
  const justfile = smallFile(join(cwd, 'justfile'), 256 * 1024) ?? smallFile(join(cwd, 'Justfile'), 256 * 1024);
  if (justfile !== undefined) {
    caps.justRecipes = new Map();
    for (const line of justfile.split(/\r?\n/)) {
      // `name params: deps` at column 0; `name := value` (settings, aliases, variables) is not a recipe.
      const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)([^:]*):(?!=)/.exec(line);
      if (m && !/^(?:set|alias|export|import|mod)$/.test(m[1]!)) caps.justRecipes.set(m[1]!, m[2]!.trim() !== '');
    }
  }
  const manifest = smallFile(join(cwd, 'package.json'), 1024 * 1024);
  if (manifest !== undefined) {
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts ?? {};
      for (const name of NPM_SCRIPTS) {
        const body = scripts[name];
        // `npm init`'s placeholder test script only fails; it is not a test suite.
        if (typeof body === 'string' && body.trim() && !/no test specified/i.test(body)) caps.npmScripts.add(name);
      }
    } catch { /* an unparsable manifest offers no npm checks */ }
  }
  return caps;
}

const SHA = /^[a-f0-9]{40}$/;
// A recipe/script name that publishes or mutates is never a review check, available or not.
const PUBLISHING_NAME = /(?:^|[-_:])(?:publish|deploy|release|preview|push|upload|ota|eas|install|update|version)(?:$|[-_:])/i;
const FATAL_BIN = /^(?:sh|bash|zsh|fish|dash|cmd|powershell|pwsh|wsl|env|sudo|node|deno|bun|npx|python[\d.]*|py|perl|ruby|php|gh|hub|curl|wget|ssh|scp|rsync|eas|expo|docker|rm|del|mv|cp)(?:\.exe|\.cmd|\.bat)?$/i;
const PACKAGE_MANAGER = /^(?:npm|pnpm|yarn)$/;
const MUTATING_PM_ACTION = /^(?:install|i|add|ci|publish|unpublish|remove|rm|uninstall|un|update|up|upgrade|link|ln|exec|x|dlx|version|pack|deprecate|dist-tag|owner|access|login|adduser|logout|token|cache|prune|dedupe|rebuild|set|config|init|create|audit)$/;
const GIT_READ_ACTIONS = new Set(['show', 'status', 'blame', 'ls-files', 'cat-file', 'rev-parse', 'shortlog', 'describe']);

function npmCommand(args: string[]): [string, string[]] {
  // Windows cannot spawn npm.cmd without a shell: run npm's own CLI script with this Node.
  const dir = dirname(process.execPath);
  for (const cli of [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(cli)) return [process.execPath, [cli, ...args]];
  }
  return ['npm', args];
}

function gitLog(rest: string[]): [string, string[]] {
  let limit = 20;
  let oneline = rest.length === 0;
  let revRange: string | undefined;
  const grepArgs: string[] = [];
  const extraFlags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const next = rest[i + 1];
    if (arg === '--oneline') oneline = true;
    else if (arg === '-n' && typeof next === 'string' && /^\d+$/.test(next)) { limit = Math.min(100, Math.max(1, parseInt(next, 10))); i++; }
    else if (/^-\d+$/.test(arg)) limit = Math.min(100, Math.max(1, parseInt(arg.slice(1), 10)));
    else if (arg.startsWith('--grep=')) grepArgs.push(arg);
    else if (arg === '--grep' && typeof next === 'string') { grepArgs.push(`--grep=${next}`); i++; }
    else if (['-i', '--stat', '--name-only', '--name-status', '--reverse'].includes(arg)) extraFlags.push(arg);
    else if (!arg.startsWith('-') && /^[a-zA-Z0-9_\-./]+(\.\.[a-zA-Z0-9_\-./]+)?$/.test(arg)) revRange = arg;
    else throw new ReviewCheckRejected(`git log does not accept "${arg}"`);
  }
  return ['git', ['log', ...(oneline ? ['--oneline'] : []), `-${limit}`, ...grepArgs, ...extraFlags, ...(revRange ? [revRange] : [])]];
}

function gitGrep(cwd: string, rest: string[]): [string, string[]] {
  const flags: string[] = ['-n'];
  let pattern: string | undefined;
  let targetPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok === '--') { targetPath = rest[i + 1]; break; }
    if (['-n', '-i', '-F', '-E', '-w'].includes(tok)) { if (!flags.includes(tok)) flags.push(tok); continue; }
    if (tok === '-e' && i + 1 < rest.length) { pattern = rest[++i]; continue; }
    if (!tok.startsWith('-') && !pattern) { pattern = tok; continue; }
    if (!tok.startsWith('-') && !targetPath) { targetPath = tok; continue; }
    throw new ReviewCheckRejected(`git grep does not accept "${tok}"`);
  }
  if (!pattern) throw new ReviewCheckRejected('git grep requires a pattern');
  return ['git', ['grep', ...flags, '-e', pattern, ...(targetPath ? ['--', checkoutPath(cwd, targetPath)] : [])]];
}

interface CheckFamily {
  /** The forms this checkout offers, exactly as the reviewer is told them. */
  usages(caps: ReviewCapabilities, base: string, head: string): string[];
  /** The shell-free command for `rest`; throws `ReviewCheckRejected` or a fatal Error. */
  resolve(cwd: string, rest: string[], caps: ReviewCapabilities): [string, string[]];
}

/** THE review check policy: the accepted forms, their availability in this checkout and how each
 * runs. The reviewer's instructions and every rejection's feedback are generated from it. */
const FAMILIES: Record<string, CheckFamily> = {
  git: {
    usages: (_caps, base, head) => [`git diff [--stat] ${base} ${head}`, 'git log [--oneline] [-n N] [--grep=TEXT] [REV|BASE..HEAD]', 'git grep [-n|-i|-F|-E|-w] PATTERN [LOCAL_PATH]'],
    resolve(cwd, [action, ...rest]) {
      if (action === 'diff') {
        const stat = rest[0] === '--stat';
        const shas = stat ? rest.slice(1) : rest;
        if (shas.length !== 2 || !shas.every((v) => SHA.test(v))) throw new ReviewCheckRejected('git diff takes [--stat] and two full commit SHAs; the full pinned diff is already supplied as a file');
        return ['git', ['diff', '--no-ext-diff', '--no-textconv', ...(stat ? ['--stat'] : []), ...shas]];
      }
      if (action === 'log') return gitLog(rest);
      if (action === 'grep') return gitGrep(cwd, rest);
      if (action && GIT_READ_ACTIONS.has(action)) throw new ReviewCheckRejected(`git ${action} is not an accepted form`);
      return refuse(`git ${action ?? ''} is not a read-only review check`);
    },
  },
  rg: {
    usages: () => ['rg [-l] PATTERN LOCAL_PATH', 'rg --files [LOCAL_PATH]'],
    resolve(cwd, rest) {
      if (rest[0] === '--files') {
        if (rest.length > 2) throw new ReviewCheckRejected('rg --files takes at most one local path');
        return ['rg', ['--files', '--glob', '!.cezar-review-tmp', ...(rest[1] === undefined ? [] : ['--', checkoutPath(cwd, rest[1], true)])]];
      }
      const list = rest[0] === '-l' || rest[0] === '--files-with-matches';
      const [pattern, path, ...extra] = list ? rest.slice(1) : rest;
      if (!pattern || pattern.startsWith('-') || path === undefined || extra.length > 0) throw new ReviewCheckRejected('rg takes [-l] PATTERN LOCAL_PATH, or --files [LOCAL_PATH]');
      return ['rg', [list ? '-l' : '-n', '--', pattern, checkoutPath(cwd, path, true)]];
    },
  },
  just: {
    usages: ({ justRecipes: r }) => [
      ...(r?.has('test') ? ['just test'] : []),
      ...(r?.get('test') ? ['just test file LOCAL_PATH...'] : []),
      ...(r?.has('check') ? ['just check'] : []),
    ],
    resolve(cwd, [recipe, ...args], { justRecipes }) {
      if (!recipe || recipe.startsWith('-')) throw new ReviewCheckRejected('just needs a recipe name');
      if (['flow', 'device', 'scenario'].includes(recipe)) throw new ReviewCheckRejected('UI/emulator checks require separate resource authorization; report them skipped');
      if (PUBLISHING_NAME.test(recipe)) refuse(`just ${recipe} is not a review check`);
      if (!justRecipes) throw new ReviewCheckRejected('this checkout has no justfile');
      if (!justRecipes.has(recipe)) throw new ReviewCheckRejected(`the justfile has no "${recipe}" recipe`);
      if ((recipe === 'test' || recipe === 'check') && args.length === 0) return ['just', [recipe]];
      if (recipe === 'test' && justRecipes.get('test') && args[0] === 'file' && args.length > 1) return ['just', ['test', 'file', ...args.slice(1).map((p) => checkoutPath(cwd, p))]];
      throw new ReviewCheckRejected(`just ${[recipe, ...args].join(' ')} is not an accepted form`);
    },
  },
  npm: {
    usages: ({ npmScripts: s }) => [
      ...(s.has('test') ? ['npm test', 'npm test -- LOCAL_PATH...'] : []),
      ...NPM_SCRIPTS.filter((n) => n !== 'test' && s.has(n)).map((n) => `npm run ${n}`),
    ],
    resolve(cwd, [action, ...args], { npmScripts }) {
      if (action === 'test' || action === 't') {
        if (!npmScripts.has('test')) throw new ReviewCheckRejected('package.json declares no test script');
        if (args.length === 0) return npmCommand(['test']);
        if (args[0] === '--' && args.length > 1) return npmCommand(['test', '--', ...args.slice(1).map((p) => checkoutPath(cwd, p))]);
        throw new ReviewCheckRejected('npm test takes no flags; pass local paths after --');
      }
      if (action === 'run' || action === 'run-script') {
        const [script, ...extra] = args;
        if (!script || script.startsWith('-')) throw new ReviewCheckRejected('npm run needs a script name');
        if (PUBLISHING_NAME.test(script)) refuse(`npm run ${script} is not a review check`);
        if (!NPM_SCRIPTS.includes(script)) throw new ReviewCheckRejected(`npm run ${script} is not an accepted form`);
        if (!npmScripts.has(script)) throw new ReviewCheckRejected(`package.json declares no "${script}" script`);
        if (extra.length > 0) throw new ReviewCheckRejected(`npm run ${script} takes no arguments`);
        return npmCommand(['run', script]);
      }
      if (!action || MUTATING_PM_ACTION.test(action)) refuse(`npm ${action ?? ''} is not a review check`);
      throw new ReviewCheckRejected(`npm ${action} is not an accepted form`);
    },
  },
};

export function reviewCheckForms(caps: ReviewCapabilities, base = 'BASE_SHA', head = 'HEAD_SHA'): string[] {
  return Object.values(FAMILIES).flatMap((family) => family.usages(caps, base, head));
}

/** The reviewer's check instructions, generated from the policy for THIS checkout. */
export function reviewCheckInstructions(caps: ReviewCapabilities, base = 'BASE_SHA', head = 'HEAD_SHA'): string {
  const example = caps.npmScripts.has('test') ? ['npm', 'test'] : caps.justRecipes?.has('test') ? ['just', 'test'] : ['git', 'diff', '--stat', base, head];
  return [
    `Checks are optional: read the code and tests first; request a check only when its result could change the verdict. Prefer the targeted tests of the changed code over the full suite; run the full suite only for a cross-cutting change. To request one, send a message whose last line is ONLY: ${CHECK_MARKER}${JSON.stringify({ args: example, reason: 'why the verdict depends on it' })}. Cezar stops the turn there, runs it without a shell and returns a result file in the next turn; do not continue the review in the same turn.`,
    'For a case-insensitive search such as include or test in a tracked vite.config.ts, if that file exists in the checkout, send this exact request as the last line of a message (the | is part of one regex argument, never a shell pipe): CEZ_REVIEW_CHECK {"args":["git","grep","-i","-E","include|test","vite.config.ts"],"reason":"inspect configuration"}. Read the returned result file before drawing conclusions. For other paths, use discovered checkout-relative paths; use rg for untracked files. A search result does not count as opening a changed file: when an existing non-binary changed file is present, separately read one with read_file or view_file and an absolute path.',
    `Accepted check forms in this checkout (one argv token per array element): ${reviewCheckForms(caps, base, head).join('; ')}. Nothing else: no shell, other flags or scripts, external paths, installs or publication. At most 6 requests and 5 minutes per command within the run timeout; UI/emulator checks are skipped.`,
    'A harmless request Cezar cannot run (unsupported form, unavailable check, missing path) returns "Check NOT RUN" with the reason: correct it or report the check as skipped. A path outside the checkout, a mutating or publishing request, or a check that changes the checkout ends the review.',
  ].join('\n');
}

export function reviewCommand(cwd: string, args: string[], caps: ReviewCapabilities = detectReviewCapabilities(cwd)): [string, string[]] {
  if (args.length > 20 || args.some((a) => a.length > 500 || /[\r\n\0]/.test(a))) refuse('argument limits exceeded');
  const [bin = '', ...rest] = args;
  try {
    const family = Object.hasOwn(FAMILIES, bin) ? FAMILIES[bin] : undefined;
    if (family) return family.resolve(cwd, rest, caps);
    if (FATAL_BIN.test(bin) || (PACKAGE_MANAGER.test(bin) && MUTATING_PM_ACTION.test(rest[0] ?? ''))) refuse(`${bin} is not a review check`);
    throw new ReviewCheckRejected(`${bin || 'an empty command'} is not an accepted check`);
  } catch (err) {
    if (err instanceof ReviewCheckRejected) {
      throw new ReviewCheckRejected(`Review command rejected: ${err.message}. Accepted forms in this checkout: ${reviewCheckForms(caps).join('; ')}`);
    }
    throw err;
  }
}

export async function executeReviewCheck(cwd: string, request: ReviewCheck, env: NodeJS.ProcessEnv, timeoutMs: number,
  onChild?: (child: ChildProcessWithoutNullStreams) => void): Promise<string> {
  if (request.args[0] === 'just' && ['flow', 'device', 'scenario'].includes(request.args[1] ?? '')) return 'UI/emulator check skipped: no separate resource authorization; no device was started.';
  let command: [string, string[]];
  try { command = reviewCommand(cwd, request.args); }
  catch (err) {
    // Only a harmless rejection becomes feedback; it is reported as NOT RUN, never as a result.
    if (!(err instanceof ReviewCheckRejected)) throw err;
    return `Check NOT RUN: ${request.args.join(' ')}\nReason: ${request.reason}\n${err.message}\nCorrect the request or report this check as skipped.`;
  }
  const [bin, args] = command;
  if (timeoutMs <= 0) throw new Error('Review command budget exhausted');
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
  }
  if (timedOut) throw new Error('Review command timed out; process tree stopped');
  if (tooLarge) throw new Error('Review command output budget exceeded; no truncated evidence accepted');
  if (error) return `Command unavailable (${error.message}); report this check as skipped.`;
  const guard = status !== 0 ? readOnlyGuardHits(output) : 0;
  return `Check: ${request.args.join(' ')}\nReason: ${request.reason}\nExit: ${status}; duration: ${Date.now() - started}ms\n${output}` +
    (guard ? `\n${READ_ONLY_GUARD_LABEL}: ${guard} output line(s) show a git push refused by the review sandbox (${READ_ONLY_PUSH_URL}). ` +
      'A failure caused only by that is an environment false negative, not a PR regression and not a pass: report it as unverified (read-only guard). Judge every other failure on its merits.' : '');
}

const READ_ONLY_GUARD_LABEL = 'Read-only guard';

/** Output lines naming the read-only push URL: failures the review sandbox itself caused
 * (live run f1082729: 18 `prScopeGuard` tests pushing to a fixture remote). Classified,
 * never worked around — the guard stays on for every check. */
export function readOnlyGuardHits(output: string): number {
  return output.split('\n').filter((line) => line.includes(READ_ONLY_PUSH_URL)).length;
}

/** One line for the published review: what Cezar itself ran and what it returned. */
export function summarizeCheckResult(result: string): string {
  const exit = /^Exit: (\S+?);/m.exec(result)?.[1];
  if (exit === undefined) return /^Check NOT RUN/.test(result) ? 'not run (request rejected)' : 'skipped';
  const guard = new RegExp(`^${READ_ONLY_GUARD_LABEL}: (\\d+)`, 'm').exec(result)?.[1];
  return `exit ${exit}${guard ? ` — ${guard} failure line(s) caused by the read-only guard (${READ_ONLY_PUSH_URL}), unverified, not counted as regressions` : ''}`;
}
