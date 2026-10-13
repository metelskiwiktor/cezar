import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyCliRunner } from './agy-cli-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { prepareReadOnlyIsolation } from './read-only-sandbox.ts';
import { executeReviewCheck, parseReviewCheck, pinnedReviewDiff, prepareReviewDiff, reviewCommand } from './review-checks.ts';
import { AgyReviewEvidence } from './agy-review-evidence.ts';

// On this Windows host use real just. Other CI hosts need no new dependency:
// the offline Node fixture stands in only when just is unavailable.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const hasJust = actual.spawnSync('just', ['--version'], { windowsHide: true }).status === 0;
  const hasRg = actual.spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;
  return { ...actual, spawn: (file: string, args: string[], opts: import('node:child_process').SpawnOptionsWithoutStdio) => {
    if (file === 'just' && !hasJust) return actual.spawn(process.execPath, [join(String(opts.cwd), 'check.cjs')], opts);
    if (file === 'rg' && !hasRg && opts.env?.PATH !== 'C:/cezar-no-such-bin') {
      return actual.spawn(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', args.at(-1) ?? ''], opts);
    }
    return actual.spawn(file, args, opts);
  } };
});

const repos: string[] = [];
function repo(script = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-review-v3-'));
  repos.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, 'AGENTS.md'), 'Review contracts; targeted tests only\n');
  writeFileSync(join(cwd, 'tracked.txt'), 'v1\n');
  writeFileSync(join(cwd, '.gitignore'), 'coverage/\n.cache/\n');
  // The real Windows just executable invokes this local, offline fixture. No API.
  writeFileSync(join(cwd, 'check.cjs'), script);
  writeFileSync(join(cwd, 'justfile'), 'set shell := ["node", "-e"]\ncheck:\n    require("./check.cjs")\ntest *paths:\n    require("./check.cjs")\n');
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
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Recommendation: APPROVE');
    expect(notes.some((n) => n.includes('Exit: 0; duration:'))).toBe(true);
    if (kind === 'test') expect(notes.join('\n')).toContain('targeted contract passed');
  });

  it('fails legacy #35 exebox/unsandboxed denial with actionable native-terminal error and no retry', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: { FAKE_AGY_MODE: 'windows-exebox' } })).rejects.toThrow(/native terminal tool rejected.*interactive permission.*Windows exebox/);
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
    // The engine sees the stopped turn end before the final review begins.
    expect(order).toEqual(['text', 'turn-end', 'text']);
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

  it('does not approve without reading trusted check results', async () => {
    const r = repo();
    await expect(runner().run({ cwd: r.cwd, userPrompt: 'Review', prReview: { mergeBase: r.base, headSha: r.head }, env: {
      FAKE_AGY_MODE: 'broker', FAKE_AGY_CHECK: JSON.stringify(['git', 'log']), FAKE_AGY_OMIT: 'check-result',
    } })).rejects.toThrow(/evidence/);
    expect(existsSync(join(r.cwd, '.cezar-review-tmp'))).toBe(false);
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
    const diff = prepareReviewDiff(r.cwd, r.base, r.head);
    try {
      expect(diff.runtimeDir).not.toContain('.ai');
      expect(diff.runtimeDir).not.toContain('cezar');
      expect(diff.runtimeDir).not.toContain(r.cwd);
      expect(existsSync(diff.runtimeDir)).toBe(true);
    } finally {
      diff.cleanup();
      expect(existsSync(diff.runtimeDir)).toBe(false);
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
  it.each([['git', 'push'], ['git', 'commit'], ['gh', 'pr'], ['just', 'preview', 'update'], ['just', 'publish', 'x'],
    ['just', 'test', 'file', '../external'], ['just', 'test', '--updateSnapshot'], ['sh', '-c', 'git diff'], ['rg', 'x', 'C:/outside']])('rejects unsafe request %j', (...args) => {
    const r = repo();
    expect(() => reviewCommand(r.cwd, args)).toThrow(/rejected/);
  });
  it('checks actual pinned HEAD, never accepts a forged empty diff', () => {
    const r = repo();
    expect(pinnedReviewDiff(r.cwd, r.base, r.head)).toContain('+v2');
    expect(() => pinnedReviewDiff(r.cwd, r.head, r.base)).toThrow(/HEAD/);
  });
  it('refuses a dirty checkout instead of reviewing files that differ from pinned HEAD', () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'tracked.txt'), 'drift\n');
    expect(() => pinnedReviewDiff(r.cwd, r.base, r.head)).toThrow(/fresh prepared PR worktree/);
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
  it('cleans only new temporary artifacts and preserves sources', async () => {
    const r = repo('const fs=require("fs"); fs.mkdirSync("coverage",{recursive:true}); fs.writeFileSync("coverage/result.txt","temporary"); console.log("passed")');
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000)).resolves.toContain('Exit: 0');
    expect(existsSync(join(r.cwd, 'coverage/result.txt'))).toBe(false);
    expect(readFileSync(join(r.cwd, 'tracked.txt'), 'utf8')).toBe('v2\n');
  });
  it('fails tracked source changes rather than silently reverting evidence', async () => {
    const r = repo('require("fs").writeFileSync("tracked.txt","changed")');
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'check'], reason: 'contract' }, process.env, 10_000)).rejects.toThrow(/source integrity violation/);
    expect(readFileSync(join(r.cwd, 'tracked.txt'), 'utf8')).toBe('changed');
  });
  it('fails changes to an existing ignored cache', async () => {
    const r = repo('require("fs").writeFileSync(".cache/result.txt","changed")');
    execFileSync(process.execPath, ['-e', 'const fs=require("fs");fs.mkdirSync(".cache");fs.writeFileSync(".cache/result.txt","baseline")'], { cwd: r.cwd });
    await expect(executeReviewCheck(r.cwd, { args: ['just', 'test'], reason: 'contract' }, process.env, 10_000)).rejects.toThrow(/source integrity violation/);
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
