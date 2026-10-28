import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyCliRunner } from './agy-cli-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { prepareReadOnlyIsolation } from './read-only-sandbox.ts';
import {
  detectReviewCapabilities, executeReviewCheck, parseReviewCheck, pinnedReviewDiff, prepareReviewDiff, reviewCheckInstructions,
  reviewCommand, ReviewCheckRejected,
} from './review-checks.ts';
import { publishReviewFromRun } from '../automations/pr-review.ts';
import { AgyReviewEvidence } from './agy-review-evidence.ts';

// On this Windows host use real just. Other CI hosts need no new dependency:
// the offline Node fixture stands in only when just is unavailable.
// The rg stand-in covers exactly the argv shapes `reviewCommand` emits — `--files [-- PATH]`,
// `-l|-n -- PATTERN PATH` — and skips dot-entries, as rg does by default.
const FAKE_RG = vi.hoisted(() => [
  'const fs = require("fs"), p = require("path"); const a = process.argv.slice(1);',
  'const walk = (d) => fs.statSync(d).isDirectory() ? fs.readdirSync(d).filter((n) => !n.startsWith(".")).flatMap((n) => walk(p.join(d, n))) : [d];',
  'if (a[0] === "--files") { const i = a.indexOf("--"); for (const f of walk(i < 0 ? "." : a[i + 1])) console.log(p.relative(".", f)); }',
  'else { const [mode, , pat, target] = a; const re = new RegExp(pat); let hit = false;',
  '  for (const f of walk(target)) { const lines = fs.readFileSync(f, "utf8").split("\\n");',
  '    if (mode === "-l") { if (lines.some((l) => re.test(l))) { hit = true; console.log(p.relative(".", f)); } }',
  '    else for (const l of lines) if (re.test(l)) { hit = true; console.log(l); } }',
  '  process.exit(hit ? 0 : 1); }',
].join('\n'));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const hasJust = actual.spawnSync('just', ['--version'], { windowsHide: true }).status === 0;
  const hasRg = actual.spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;
  return { ...actual, spawn: (file: string, args: string[], opts: import('node:child_process').SpawnOptionsWithoutStdio) => {
    if (file === 'just' && !hasJust) return actual.spawn(process.execPath, [join(String(opts.cwd), 'check.cjs')], opts);
    if (file === 'rg' && !hasRg && opts.env?.PATH !== 'C:/cezar-no-such-bin') {
      return actual.spawn(process.execPath, ['-e', FAKE_RG, '--', ...args], opts);
    }
    return actual.spawn(file, args, opts);
  } };
});

const repos: string[] = [];
function repo(script = '', opts: { justfile?: boolean; agents?: boolean; scripts?: Record<string, string> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-review-v3-'));
  repos.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  if (opts.agents !== false) writeFileSync(join(cwd, 'AGENTS.md'), 'Review contracts; targeted tests only\n');
  writeFileSync(join(cwd, 'tracked.txt'), 'v1\n');
  writeFileSync(join(cwd, '.gitignore'), 'coverage/\n.cache/\n');
  // The real Windows just executable invokes this local, offline fixture. No API.
  writeFileSync(join(cwd, 'check.cjs'), script);
  if (opts.justfile !== false) writeFileSync(join(cwd, 'justfile'), 'set shell := ["node", "-e"]\ncheck:\n    require("./check.cjs")\ntest *paths:\n    require("./check.cjs")\n');
  if (opts.scripts) writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: opts.scripts }));
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'tracked.txt'), 'v2\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'head');
  return { cwd, base, head: git('rev-parse', 'HEAD') };
}
afterEach(() => { for (const p of repos.splice(0)) rmSync(p, { recursive: true, force: true }); });
const fake = fileURLToPath(new URL('./__fixtures__/fake-agy.mjs', import.meta.url));
const runner = () => new AgyCliRunner({ bin: process.execPath, binArgs: [fake], timeoutMs: 20_000 });

describe('brokered Windows review', { timeout: 30_000 }, () => {
  it.each(['diff', 'stat', 'grep', 'test'])('completes headlessly with real Cezar-owned %s and mock Agy, without exebox', async (kind) => {
    const r = repo('console.log("targeted contract passed")');
    const args = kind === 'diff' ? ['git', 'diff', r.base, r.head] : kind === 'stat' ? ['git', 'diff', '--stat', r.base, r.head] : kind === 'grep' ? ['git', 'grep', 'v2', 'tracked.txt'] : ['just', 'test'];
    const notes: string[] = [];
    const texts: string[] = [];
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', sessionId: 'MAIN_IMPLEMENTATION_HISTORY', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(args), FAKE_AGY_ASSERT_PR_SCOPE: '1',
      GH_TOKEN: 'never-forward', EXPO_TOKEN: 'never-forward', EAS_TOKEN: 'never-forward', EAS_ACCESS_TOKEN: 'never-forward', CEZ_HANDOFF_FILE: 'outside',
    } }, (e) => { if (e.type === 'note') notes.push(e.message); if (e.type === 'text') texts.push(e.text); });
    expect(result.text).toContain('Recommendation: APPROVE');
    expect(result.text).not.toContain('CEZ_REVIEW_CHECK');
    // The review, then Cezar's own coverage section naming the check it ran and its real outcome.
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Recommendation: APPROVE');
    expect(texts[1]).toContain(`### Review coverage (reported by Cezar)\n- Check \`${args.join(' ')}\`: exit 0`);
    expect(notes.some((n) => n.includes('Exit: 0; duration:'))).toBe(true);
    if (kind === 'test') expect(notes.join('\n')).toContain('targeted contract passed');
  });

  it('recovers once from a Windows native terminal attempt, reads changed code and runs a brokered check', async () => {
    const r = repo();
    const notes: string[] = [];
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'native-recovery' } }, (e) => { if (e.type === 'note') notes.push(e.message); });
    expect(result.text).toContain('Recommendation: APPROVE');
    expect(result.text).toContain('Check `git grep v2 tracked.txt`: exit 0');
    expect(notes.join(' ')).toContain('Native terminal attempt stopped');
  });

  it('never accepts a continuation without changed-file evidence', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'native-recovery', FAKE_AGY_OMIT_CHANGED: '1' } })).rejects.toThrow(/no changed file was opened/);
  });

  it('stops repeated native commands without executing them', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'native-recovery', FAKE_AGY_REPEAT_NATIVE: '1', FAKE_AGY_NATIVE_COMMAND: 'rm tracked.txt' } })).rejects.toThrow(/native terminal was requested again/);
    expect(readFileSync(join(r.cwd, 'tracked.txt'), 'utf8')).toBe('v2\n');
  });

  it('refuses continuation if the native tool changed the checkout before its event', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'native-recovery', FAKE_AGY_NATIVE_MUTATE: '1' } })).rejects.toThrow(/checkout changed/);
  });

  it('keeps a streamed native permission denial fatal', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'native-recovery', FAKE_AGY_NATIVE_DENIAL: '1' } })).rejects.toThrow(/permission/i);
  });

  it('bounds repeat check requests instead of looping indefinitely', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_REPEAT: '1',
    } })).rejects.toThrow(/request budget exceeded/);
  }, 20_000);

  it('executes a mid-turn check request exactly once, stops that turn and concludes only after the result (live run 2bb661b9)', async () => {
    const r = repo('console.log("targeted contract passed")');
    const notes: string[] = [];
    const texts: string[] = [];
    const order: string[] = [];
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['just', 'test', 'file', 'tracked.txt']), FAKE_AGY_MIDTURN: '1',
    } }, (e) => {
      if (e.type === 'note') notes.push(e.message);
      if (e.type === 'text') { texts.push(e.text); order.push('text'); }
      if (e.type === 'turn-end') order.push('turn-end');
    });
    expect(notes.filter((n) => n.includes('Exit: 0; duration:'))).toHaveLength(1);
    expect(notes.join('\n')).toContain('targeted contract passed');
    expect(result.text).toContain('Recommendation: APPROVE');
    expect(result.text).toContain('just test file tracked.txt returned exit 0');
    expect(result.text).not.toMatch(/UNCHECKED|Planning verification|CEZ_REVIEW_CHECK/);
    expect(texts.join('\n')).not.toContain('UNCHECKED');
    expect(result.text).toContain('- Check `just test file tracked.txt`: exit 0');
    // The engine sees the stopped turn end before the final review begins; the final review
    // and Cezar's coverage section are the same (last) turn.
    expect(order).toEqual(['text', 'turn-end', 'text', 'text']);
  });

  it('does not accept a late format error when the requested check result was never read', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_OMIT: 'check-result', FAKE_AGY_RESULT_ERROR: 'malformed',
    } })).rejects.toThrow(/recovery refused: review evidence is incomplete.*nothing is published|recovery refused: review evidence is incomplete/i);
  });

  it('accepts a late format error after the requested check ran and its result was read', async () => {
    const r = repo();
    const notes: string[] = [];
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_MIDTURN: '1', FAKE_AGY_RESULT_ERROR: 'malformed',
    } }, (e) => { if (e.type === 'note') notes.push(e.message); })).resolves.toMatchObject({ text: expect.stringContaining('Recommendation: APPROVE') });
    expect(notes.filter((n) => n.includes('Exit: 0; duration:'))).toHaveLength(1);
  });

  it('discloses an unread trusted check result beside the review instead of withholding it', async () => {
    const r = repo();
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_OMIT: 'check-result',
    } });
    expect(result.text).toContain('Recommendation: APPROVE');
    // Cezar states the real outcome itself, so an unread result cannot be misreported.
    expect(result.text).toContain('- Check `git log`: exit 0');
    expect(result.text).toContain("- Not verified: 1 check result(s) were not fully read by the reviewer (outcomes below are Cezar's)");
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
  });

  it('reports test failures caused by the read-only push guard as unverified, never bypassing the guard (live run f1082729)', async () => {
    // A repository test that pushes to a local fixture remote, like Tabnote's prScopeGuard suite.
    const r = repo([
      'const { execFileSync } = require("child_process"); const { mkdtempSync } = require("fs"); const { join } = require("path");',
      'const d = mkdtempSync(join(require("os").tmpdir(), "guard-")); const w = join(d, "w"); const g = (...a) => execFileSync("git", a, { cwd: w, stdio: "pipe" });',
      'execFileSync("git", ["init", "-q", "--bare", join(d, "remote.git")]); execFileSync("git", ["init", "-q", w]);',
      'g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"); g("remote", "add", "origin", join(d, "remote.git"));',
      'try { g("push", "-q", "origin", "HEAD:refs/heads/main"); console.log("PUSHED"); } catch (e) { console.error("push failed: " + String(e.stderr)); process.exit(1); }',
    ].join('\n'));
    const notes: string[] = [];
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['just', 'test']),
      FAKE_AGY_VERDICT: 'Findings: none. The only failing test pushes to a remote, which the read-only review blocks.\nRecommendation: COMMENT',
    } }, (e) => { if (e.type === 'note') notes.push(e.message); });
    const check = notes.find((n) => n.startsWith('Check: just test'))!;
    // The guard stayed on: the push really failed, naming the sandbox's push URL.
    expect(check).toMatch(/Exit: 1;/);
    expect(check).not.toContain('PUSHED');
    expect(check).toMatch(/Read-only guard: \d+ output line\(s\) show a git push refused by the review sandbox \(DISABLED_READ_ONLY_REVIEW\)/);
    expect(check).toContain('not a PR regression and not a pass');
    expect(result.text).toMatch(/- Check `just test`: exit 1 — \d+ failure line\(s\) caused by the read-only guard \(DISABLED_READ_ONLY_REVIEW\), unverified, not counted as regressions/);
    const publish = await publishReviewFromRun({ repoRoot: r.cwd, text: result.text, runner: 'agy',
      target: { repo: 'metelskiwiktor/cezar', number: 7, headSha: r.head, baseRef: 'origin/main', mergeBase: r.base },
      run: async (_bin, args) => (args.includes('.head.sha') ? r.head : '') });
    expect(publish).toEqual({ status: 'published' });
  });
  it('cancels a running trusted check, kills its process tree and never emits done', async () => {
    const r = repo('require("fs").writeFileSync(".cezar-review-tmp/cancel-ready","ready");setInterval(()=>{},1000)');
    let done = false;
    const session = runner().startSession({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['just', 'test']),
    } }, (e) => { if (e.type === 'done') done = true; });
    const outcome = session.result.catch((e: unknown) => e);
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(r.cwd, '.cezar-review-tmp/cancel-ready')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const pid = session.pid;
    session.interrupt();
    expect(await outcome).toMatchObject({ message: expect.stringContaining('cancelled') });
    expect(pid).toBeDefined();
    expect(() => process.kill(Number(pid), 0)).toThrow();
    expect(done).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'Retry' }])).toBe(false);
  });

  it('transports a diff beyond the Windows argv limit as fully inspected checkout data', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'tracked.txt'), 'v2\n' + 'contract\n'.repeat(5000));
    execFileSync('git', ['add', '.'], { cwd: r.cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'large diff'], { cwd: r.cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim();
    expect(pinnedReviewDiff(r.cwd, r.base, head).length).toBeGreaterThan(32_000);
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_ASSERT_PR_SCOPE: '1',
    } })).resolves.toMatchObject({ text: expect.stringContaining('Recommendation: APPROVE') });
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
  }, 20_000);

  it('accepts unranged view_file on diff and check result for single-view reviews (live run 2ac98267 pattern)', async () => {
    const r = repo('console.log("contract check passed")');
    const notes: string[] = [];
    const result = await runner().run({
      cwd: r.cwd,
      userPrompt: 'Review',
      prReview: { mergeBase: r.base, headSha: r.head },
      env: {
        FAKE_AGY_MODE: 'broker',
        FAKE_AGY_CHECK: JSON.stringify(['just', 'test']),
        FAKE_AGY_DIFF_VIEW_MODE: 'no-range',
        FAKE_AGY_CHECK_VIEW_MODE: 'no-range',
      },
    }, (e) => { if (e.type === 'note') notes.push(e.message); });
    expect(result.text).toContain('Recommendation: APPROVE');
    expect(notes.some((n) => n.includes('Exit: 0'))).toBe(true);
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
  });

  it('delivers large diff via split parts and requires inspecting all parts', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'tracked.txt'), 'v2\n' + 'contract\n'.repeat(1200));
    execFileSync('git', ['add', '.'], { cwd: r.cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'chunked diff'], { cwd: r.cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim();

    // 1. All parts inspected via parts-only view -> succeeds
    await expect(runner().run({
      cwd: r.cwd,
      userPrompt: 'Review',
      prReview: { mergeBase: r.base, headSha: head },
      env: {
        FAKE_AGY_MODE: 'broker',
        FAKE_AGY_CHECK: JSON.stringify(['git', 'log']),
        FAKE_AGY_DIFF_VIEW_MODE: 'parts-only',
      },
    })).resolves.toMatchObject({ text: expect.stringContaining('Recommendation: APPROVE') });

    // 2. Partial parts inspected -> fails closed (incomplete evidence)
    await expect(runner().run({
      cwd: r.cwd,
      userPrompt: 'Review',
      prReview: { mergeBase: r.base, headSha: head },
      env: {
        FAKE_AGY_MODE: 'broker',
        FAKE_AGY_CHECK: JSON.stringify(['git', 'log']),
        FAKE_AGY_DIFF_VIEW_MODE: 'partial-parts',
      },
    })).rejects.toThrow(/evidence/);
  }, 30_000);

  it('reproduces and completes live run 2ac98267 scenario: 320-line diff, no range view_file, test exit 1, CHANGES REQUESTED', async () => {
    const r = repo('console.error("test assertion failed: expected null but received agent worktree"); process.exit(1)');
    writeFileSync(join(r.cwd, 'tracked.txt'), 'v2\n' + 'line\n'.repeat(318));
    execFileSync('git', ['add', '.'], { cwd: r.cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', '320 lines PR'], { cwd: r.cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim();

    const verdict = 'Findings:\nP1 scripts/lib/previewPublishGuard.test.js:8: Test failed with exit 1: test assertion failed.\nP2 scripts/preview.mjs:15: Unhandled null return.\nRecommendation: CHANGES REQUESTED';
    const notes: string[] = [];
    const result = await runner().run({
      cwd: r.cwd,
      userPrompt: 'Review',
      prReview: { mergeBase: r.base, headSha: head },
      env: {
        FAKE_AGY_MODE: 'broker',
        FAKE_AGY_CHECK: JSON.stringify(['just', 'test']),
        FAKE_AGY_DIFF_VIEW_MODE: 'no-range',
        FAKE_AGY_CHECK_VIEW_MODE: 'no-range',
        FAKE_AGY_VERDICT: verdict,
      },
    }, (e) => { if (e.type === 'note') notes.push(e.message); });

    expect(result.text).toContain('Recommendation: CHANGES REQUESTED');
    expect(result.text).toContain('P1 scripts/lib/previewPublishGuard.test.js');
    expect(notes.some((n) => n.includes('Exit: 1'))).toBe(true);
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
  });

  it('isolates check runtimeDir in OS tmpdir and never places it inside .ai/cezar/worktrees', () => {
    const r = repo();
    // A hosted cezar task legitimately points TEMP at `.ai/cezar/tmp/<run>`, so the assertion is
    // relative to a controlled temp root rather than to whatever path the host happens to use.
    const tempRoot = mkdtempSync(join(tmpdir(), 'cez-rt-root-'));
    vi.stubEnv('TMPDIR', tempRoot);
    vi.stubEnv('TMP', tempRoot);
    vi.stubEnv('TEMP', tempRoot);
    let diff: ReturnType<typeof prepareReviewDiff> | undefined;
    try {
      diff = prepareReviewDiff(r.cwd, r.base, r.head);
      const inRoot = relative(tempRoot, diff.runtimeDir);
      expect(inRoot && !inRoot.startsWith('..') && !isAbsolute(inRoot)).toBe(true);
      expect(relative(r.cwd, diff.runtimeDir).startsWith('..')).toBe(true);
      expect(diff.runtimeDir.replace(/\\/g, '/')).not.toContain('.ai/cezar/worktrees');
      expect(existsSync(diff.runtimeDir)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      diff?.cleanup();
      if (diff) expect(existsSync(diff.runtimeDir)).toBe(false);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('trusted check policy and source integrity', { timeout: 30_000 }, () => {
  it('parses a single justified request, rejects mixed final verdict and request', () => {
    expect(parseReviewCheck('CEZ_REVIEW_CHECK {"args":["just","check"],"reason":"contract"}')).toEqual({ args: ['just', 'check'], reason: 'contract' });
    expect(() => parseReviewCheck('CEZ_REVIEW_CHECK {}\nRecommendation: APPROVE')).toThrow();
  });
  it('does not interpret a finding mentioning the protocol as a command request', () => {
    expect(parseReviewCheck('P2 src/runner.ts:10: CEZ_REVIEW_CHECK must validate arguments.\nRecommendation: CHANGES REQUESTED')).toBeUndefined();
  });
  it.each([['git', 'push'], ['git', 'commit'], ['gh', 'pr'], ['just', 'preview', 'update'], ['just', 'publish', 'x'], ['npm', 'install'],
    ['npm', 'run', 'publish'], ['just', 'test', 'file', '../external'], ['sh', '-c', 'git diff'], ['rg', 'x', 'C:/outside'], ['rg', '--files', '..'],
    ['rg', '-l', 'x', '../outside']])('refuses unsafe request %j fatally', (...args) => {
    const r = repo();
    let error: unknown;
    try { reviewCommand(r.cwd, args); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ReviewCheckRejected);
    expect((error as Error).message).toMatch(/refused/);
  });
  it.each([['just', 'test', '--updateSnapshot'], ['rg', '--files', 'no-such-dir'], ['npm', 'test'], ['npm', 'run', 'lint'], ['git', 'show', 'HEAD'],
    ['jest'], ['rg', 'pattern']])('rejects harmless unavailable request %j with the accepted forms', (...args) => {
    const r = repo();
    expect(() => reviewCommand(r.cwd, args)).toThrow(ReviewCheckRejected);
    expect(() => reviewCommand(r.cwd, args)).toThrow(/rejected: .*Accepted forms in this checkout: .*just test; just test file LOCAL_PATH\.\.\.; just check/);
  });
  it('checks actual pinned HEAD, never accepts a forged empty diff', () => {
    const r = repo();
    expect(pinnedReviewDiff(r.cwd, r.base, r.head)).toContain('+v2');
    expect(() => pinnedReviewDiff(r.cwd, r.head, r.base)).toThrow(/HEAD/);
  });
  it('does not refuse a locally modified checkout: the diff is computed from the pinned commits', () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'tracked.txt'), 'drift\n');
    writeFileSync(join(r.cwd, 'scratch.txt'), 'x\n');
    expect(pinnedReviewDiff(r.cwd, r.base, r.head)).toContain('+v2');
  });
  it('reads version-matched shared dependencies through Cezar rg without granting arbitrary external paths', async (context) => {
    const r = repo();
    writeFileSync(join(r.cwd, '.gitignore'), 'node_modules/\ncoverage/\n.cache/\n');
    writeFileSync(join(r.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/demo': { version: '1.0.0' } } }));
    execFileSync('git', ['add', '.'], { cwd: r.cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'lock'], { cwd: r.cwd });
    const pkg = join(r.cwd, 'node_modules/demo');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(join(pkg, 'index.d.ts'), 'declare const knownContract: string;\n');
    const worktree = join(r.cwd, 'review-checkout');
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: r.cwd, stdio: 'ignore' });
    try { symlinkSync(join(r.cwd, 'node_modules'), join(worktree, 'node_modules'), 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Windows directory symlink privilege unavailable'); return; }
      throw error;
    }
    const args = ['rg', 'knownContract', 'node_modules/demo/index.d.ts'];
    await expect(executeReviewCheck(worktree, { args, reason: 'dependency API contract' }, process.env, 10_000)).resolves.toContain('knownContract: string');
    expect(() => reviewCommand(worktree, ['just', 'test', 'file', 'node_modules/demo/index.d.ts'])).toThrow();
    writeFileSync(join(pkg, 'package.json'), '{"version":"2.0.0"}');
    expect(() => reviewCommand(worktree, args)).toThrow();
    const privateDir = join(r.cwd, 'outside-cache');
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, 'secret.txt'), 'fixture only');
    symlinkSync(privateDir, join(pkg, 'leak'), 'dir');
    expect(() => reviewCommand(worktree, ['rg', '.', 'node_modules/demo/leak/secret.txt'])).toThrow();
  });
  it('confirms diff delivery via default read for <= 800 lines and requires full coverage for larger diffs', () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'asset.bin'), Buffer.from([0, 1, 2]));
    execFileSync('git', ['add', '.'], { cwd: r.cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'binary'], { cwd: r.cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim();
    const diff = prepareReviewDiff(r.cwd, r.head, head);
    try {
      const read = (evidence: AgyReviewEvidence, id: string, path: string, range = {}) => {
        evidence.call({ id, name: 'view_file', input: { AbsolutePath: path, ...range } });
        evidence.result(id, false, '');
      };
      // 1. Single view diff (<= 800 lines): unranged view_file completes it
      const ev1 = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.head, headSha: head } });
      ev1.deliverTrustedDiff(diff.file, diff.lines, diff.parts);
      read(ev1, 'agents', join(r.cwd, 'AGENTS.md'));
      read(ev1, 'default', diff.file);
      expect(ev1.complete()).toBe(true);

      // 2. Large diff (> 800 lines): unranged view_file alone does not complete it
      const ev2 = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.head, headSha: head } });
      ev2.deliverTrustedDiff(diff.file, 1000);
      read(ev2, 'agents', join(r.cwd, 'AGENTS.md'));
      read(ev2, 'default', diff.file);
      expect(ev2.complete()).toBe(false);
      read(ev2, 'rem', diff.file, { StartLine: 801, EndLine: 1000 });
      expect(ev2.complete()).toBe(true);

      expect(ev1.allowsFileInspection({ id: 'outside', name: 'list_dir', input: { DirectoryPath: join(r.cwd, '..') } })).toBe(false);
    } finally { diff.cleanup(); }
  });
  it('handles presence vs absence of AGENTS.md in checkout', () => {
    const r = repo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim();
    const diff = prepareReviewDiff(r.cwd, r.base, head);
    try {
      const read = (evidence: AgyReviewEvidence, id: string, path: string, range = {}) => {
        evidence.call({ id, name: 'view_file', input: { AbsolutePath: path, ...range } });
        evidence.result(id, false, '');
      };

      // Case 1: AGENTS.md exists in repo (repo() creates it) -> unread, it is a disclosed gap,
      // never a reason to withhold the review (live run f1082729); the stricter bar still wants it.
      const evWithAgents = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: head } });
      evWithAgents.deliverTrustedDiff(diff.file, diff.lines, diff.parts);
      read(evWithAgents, 'diff', diff.file);
      read(evWithAgents, 'tracked', join(r.cwd, 'tracked.txt'));
      expect(evWithAgents.complete()).toBe(true);
      expect(evWithAgents.gaps()).toEqual(['AGENTS.md was not read']);
      expect(evWithAgents.strictComplete()).toBe(false);
      read(evWithAgents, 'agents', join(r.cwd, 'AGENTS.md'));
      expect(evWithAgents.gaps()).toEqual([]);
      expect(evWithAgents.strictComplete()).toBe(true);

      // Case 2: Repository WITHOUT AGENTS.md (e.g. cezar-adapter)
      rmSync(join(r.cwd, 'AGENTS.md'));
      const evWithoutAgents = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: head } });
      evWithoutAgents.deliverTrustedDiff(diff.file, diff.lines, diff.parts);
      read(evWithoutAgents, 'diff', diff.file);
      read(evWithoutAgents, 'tracked', join(r.cwd, 'tracked.txt'));
      // AGENTS.md does not exist -> review is complete without reading it
      expect(evWithoutAgents.complete()).toBe(true);

      // Harmless ENOENT reading of optional missing AGENTS.md does not void review
      evWithoutAgents.call({ id: 'miss_agents', name: 'view_file', input: { AbsolutePath: join(r.cwd, 'AGENTS.md') } });
      const forgiven = evWithoutAgents.result('miss_agents', true, 'ENOENT: no such file or directory');
      expect(forgiven).toBe(true);
      expect(evWithoutAgents.complete()).toBe(true);
    } finally {
      diff.cleanup();
    }
  });
  it('blocks only on critical evidence: the pinned diff and a changed file, never on a failed side read', () => {
    const r = repo();
    const diff = prepareReviewDiff(r.cwd, r.base, r.head);
    try {
      let n = 0;
      const read = (evidence: AgyReviewEvidence, path: string, error?: string) => {
        const id = `c${++n}`;
        evidence.call({ id, name: 'view_file', input: { AbsolutePath: path } });
        evidence.result(id, error !== undefined, error ?? '');
      };
      const ev = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head } });
      ev.deliverTrustedDiff(diff.file, diff.lines, diff.parts);
      expect(ev.missingCritical()).toEqual(['the full pinned PR diff was not read', 'no changed file was opened']);
      read(ev, diff.file);
      expect(ev.missingCritical()).toEqual(['no changed file was opened']);
      read(ev, join(r.cwd, 'tracked.txt'));
      // 1 failed read among 29 attempts (live run f1082729: `.github/workflows/release.yml`).
      for (let i = 0; i < 26; i++) read(ev, join(r.cwd, 'AGENTS.md'));
      read(ev, join(r.cwd, '.github', 'workflows', 'release.yml'), 'GetFileAttributesEx: The system cannot find the file specified.');
      expect(ev.complete()).toBe(true);
      expect(ev.gaps()).toEqual(['1 file read(s) failed: .github/workflows/release.yml']);
      // Not at the pinned HEAD: nothing the review says is tied to the PR.
      const moved = new AgyReviewEvidence({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.base } });
      expect(moved.missingCritical()).toEqual([expect.stringContaining('not at the pinned PR HEAD')]);
      expect(moved.complete()).toBe(false);
    } finally { diff.cleanup(); }
  });
  it('keeps generated artifacts and local edits from a check without failing it', async () => {
    const r = repo('const fs=require("fs"); fs.mkdirSync("coverage",{recursive:true}); fs.writeFileSync("coverage/result.txt","temporary"); fs.writeFileSync("tracked.txt","changed"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/out.js","x"); console.log("passed")');
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000)).resolves.toContain('Exit: 0');
    expect(readFileSync(join(r.cwd, 'coverage/result.txt'), 'utf8')).toBe('temporary');
    expect(readFileSync(join(r.cwd, 'dist/out.js'), 'utf8')).toBe('x');
    expect(readFileSync(join(r.cwd, 'tracked.txt'), 'utf8')).toBe('changed');
  });
  it('does not fail a check that rewrites an existing ignored cache', async () => {
    const r = repo('require("fs").writeFileSync(".cache/result.txt","changed")');
    execFileSync(process.execPath, ['-e', 'const fs=require("fs");fs.mkdirSync(".cache");fs.writeFileSync(".cache/result.txt","baseline")'], { cwd: r.cwd });
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000)).resolves.toContain('Exit: 0');
    expect(readFileSync(join(r.cwd, '.cache/result.txt'), 'utf8')).toBe('changed');
  });
  it('kills a hanging check at the deadline and rejects a spent budget', async () => {
    const r = repo('setInterval(()=>{},1000)');
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 400)).rejects.toThrow(/timed out/);
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 0)).rejects.toThrow(/budget exhausted/);
  });
  it('reports unavailable UI as skipped without booting a device', async () => {
    const r = repo();
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'flow', 'all'], reason: 'UI' }, process.env, 1000)).resolves.toContain('skipped');
  });
  it('fails the output budget instead of supplying silently truncated evidence', async () => {
    const r = repo('process.stdout.write("x".repeat(2*1024*1024))');
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000)).rejects.toThrow(/output budget exceeded/);
  });
  it('reports a missing inspection executable as skipped, never passed', async () => {
    const r = repo();
    await expect(executeReviewCheck(r.cwd, { args: ['rg', 'v2', 'tracked.txt'], reason: 'contract' }, { ...process.env, PATH: 'C:/cezar-no-such-bin' }, 10_000)).resolves.toContain('report this check as skipped');
  });
  it('runs checks without publication credentials', async () => {
    const r = repo('if(process.env.GH_TOKEN||process.env.EXPO_TOKEN)process.exit(7);console.log("no credentials")');
    const isolation = prepareReadOnlyIsolation();
    try {
      const env = buildChildEnv({ backend: 'agy', readOnly: true, source: { ...process.env, GH_TOKEN: 'secret', EXPO_TOKEN: 'secret' }, extraEnv: isolation.env });
      await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, env, 10_000)).resolves.toContain('Exit: 0');
    } finally { isolation.cleanup(); }
  });
});

describe('check policy follows the prepared checkout (cezar-adapter#8 run ee37f4e1)', { timeout: 60_000 }, () => {
  const ADAPTER_SCRIPTS = { test: 'node check.cjs', check: 'node check.cjs' };

  it('offers npm forms for a package.json repo without a justfile, never an absent just', () => {
    const r = repo('', { justfile: false, scripts: ADAPTER_SCRIPTS });
    const text = reviewCheckInstructions(detectReviewCapabilities(r.cwd), r.base, r.head);
    expect(text).toContain('npm test; npm test -- LOCAL_PATH...; npm run check');
    expect(text).toContain('{"args":["npm","test"]');
    expect(text).not.toMatch(/\bjust\b/);
    expect(text).not.toContain('npm run typecheck');
  });

  it('offers only the recipes a justfile really declares', () => {
    const r = repo();
    const text = reviewCheckInstructions(detectReviewCapabilities(r.cwd), r.base, r.head);
    expect(text).toContain('just test; just test file LOCAL_PATH...; just check');
    expect(text).toContain('{"args":["just","test"]');
    expect(text).not.toMatch(/\bnpm\b/);
  });

  it('offers only read-only inspection when the checkout has neither, and ignores the npm init placeholder', () => {
    const r = repo('', { justfile: false, scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    const text = reviewCheckInstructions(detectReviewCapabilities(r.cwd), r.base, r.head);
    expect(text).not.toMatch(/\b(?:just|npm)\b/);
    expect(text).toContain(`git diff [--stat] ${r.base} ${r.head}`);
    expect(text).toContain('rg --files [LOCAL_PATH]');
    expect(text).toContain(`{"args":["git","diff","--stat","${r.base}","${r.head}"]`);
  });

  it('runs the declared npm scripts and reports a red test as red', async () => {
    const r = repo('console.log("npm suite ran"); process.exit(process.argv.includes("fail") ? 1 : 0)', { justfile: false, scripts: { ...ADAPTER_SCRIPTS, check: 'node check.cjs fail' } });
    const green = await executeReviewCheck(r.cwd, { args: ['npm', 'test'], reason: 'contract' }, process.env, 60_000);
    expect(green).toMatch(/Exit: 0;[\s\S]*npm suite ran/);
    await expect(executeReviewCheck(r.cwd, { args: ['npm', 'run', 'check'], reason: 'contract' }, process.env, 60_000)).resolves.toMatch(/Exit: 1;/);
  });

  it('lists files and matching files through rg, inside the checkout only', async () => {
    const r = repo();
    mkdirSync(join(r.cwd, 'tests'));
    writeFileSync(join(r.cwd, 'tests/a.test.ts'), 'contract v2\n');
    const files = await executeReviewCheck(r.cwd, { args: ['rg', '--files', 'tests'], reason: 'find tests' }, process.env, 10_000);
    expect(files).toMatch(/Exit: 0;[\s\S]*tests[\\/]a\.test\.ts/);
    const root = await executeReviewCheck(r.cwd, { args: ['rg', '--files'], reason: 'layout' }, process.env, 10_000);
    expect(root).toContain('tracked.txt');
    expect(root).not.toContain('.cezar-review-tmp');
    await expect(executeReviewCheck(r.cwd, { args: ['rg', '-l', 'v2', '.'], reason: 'callers' }, process.env, 10_000)).resolves.toMatch(/tracked\.txt/);
    await expect(executeReviewCheck(r.cwd, { args: ['rg', '--files', '../'], reason: 'escape' }, process.env, 10_000)).rejects.toThrow(/refused: .*escapes the checkout/);
  });

  it('returns a harmless unavailable check as NOT RUN feedback without executing anything', async () => {
    const r = repo('require("fs").writeFileSync("ran.txt","x")', { justfile: false, scripts: ADAPTER_SCRIPTS });
    const result = await executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000);
    expect(result).toMatch(/^Check NOT RUN: just test/);
    expect(result).toContain('this checkout has no justfile');
    expect(result).toContain('npm test; npm test -- LOCAL_PATH...; npm run check');
    expect(result).not.toMatch(/Exit:/);
    expect(existsSync(join(r.cwd, 'ran.txt'))).toBe(false);
  });

  it('feeds a rejected check back to fake Agy, runs the corrected one and publishes the review', async () => {
    const r = repo('console.log("adapter suite passed")', { justfile: false, agents: false, scripts: ADAPTER_SCRIPTS });
    const notes: string[] = [];
    const result = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECKS: JSON.stringify([['just', 'test'], ['npm', 'test']]), FAKE_AGY_ASSERT_PR_SCOPE: '1',
      FAKE_AGY_PROMPT_HAS: 'npm test; npm test -- LOCAL_PATH...; npm run check|Checkout AGENTS.md: absent',
      FAKE_AGY_PROMPT_LACKS: 'just test|just check|Checkout AGENTS.md: present',
    } }, (e) => { if (e.type === 'note') notes.push(e.message); });
    expect(notes.some((n) => n.startsWith('Check NOT RUN: just test') && n.includes('no justfile'))).toBe(true);
    expect(notes.some((n) => /Exit: 0;[\s\S]*adapter suite passed/.test(n))).toBe(true);
    expect(result.text).toContain('Recommendation: APPROVE');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim()).toBe(r.head);
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);

    const posts: string[] = [];
    const published = await publishReviewFromRun({ repoRoot: r.cwd, target: { repo: 'o/cezar-adapter', number: 8, headSha: r.head, baseRef: 'origin/main', mergeBase: r.base },
      text: result.text, model: 'gemini', runner: 'agy', run: async (_exe, args) => {
        if (args.includes('--jq') && args.includes('.head.sha')) return r.head;
        const input = args.indexOf('--input');
        if (input >= 0) posts.push(readFileSync(args[input + 1]!, 'utf8'));
        return '';
      } });
    expect(published).toEqual({ status: 'published' });
    expect(posts.join('')).toContain('Recommendation: APPROVE');
  });

  it('publishes a review after a check changes source and dist, and reports its non-zero exit as a failed check (PR #16)', async () => {
    const r = repo('const fs=require("fs");fs.writeFileSync("tracked.txt","regenerated");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/a.js","x");process.exit(process.argv.includes("fail")?1:0)',
      { justfile: false, scripts: { ...ADAPTER_SCRIPTS, check: 'node check.cjs fail' } });
    const notes: string[] = [];
    const outcome = await runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECKS: JSON.stringify([['npm', 'test'], ['npm', 'run', 'check']]),
    } }, (e) => { if (e.type === 'note') notes.push(e.message); });
    expect(outcome.text).toContain('Recommendation:');
    expect(notes.some((n) => /Exit: 1;/.test(n))).toBe(true);
    expect(readFileSync(join(r.cwd, 'tracked.txt'), 'utf8')).toBe('regenerated');
    expect(existsSync(join(r.cwd, 'dist/a.js'))).toBe(true);
  });

  it('ends the review fatally when a requested check escapes the checkout', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECKS: JSON.stringify([['rg', '--files', '../']]),
    } })).rejects.toThrow(/refused: .*escapes the checkout/);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.cwd, encoding: 'utf8' }).trim()).toBe(r.head);
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
  });
});
