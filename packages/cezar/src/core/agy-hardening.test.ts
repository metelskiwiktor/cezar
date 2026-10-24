import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv } from './agent-env.ts';
import { AgyCliRunner, killAgyTree, MUTATING_TOOL_NAMES, serveCheckoutRead } from './agy-cli-runner.ts';
import { getWorkspaceGitSnapshot, prepareReadOnlyIsolation, verifyWorkspaceIntegrity } from './read-only-sandbox.ts';
import { prReviewMarker, publishReviewFromRun } from '../automations/pr-review.ts';

describe('AgyCliRunner security hardening & isolation', () => {
  describe('1. GitHub credentials stripping and leak prevention', () => {
    it('strips all host GitHub credentials when readOnly is true', () => {
      const host: NodeJS.ProcessEnv = {
        PATH: '/bin',
        HOME: '/home/user',
        GITHUB_TOKEN: 'super-secret-gh-token',
        GH_TOKEN: 'gh-cli-token',
        GH_ENTERPRISE_TOKEN: 'ghe-token',
        GITHUB_PAT: 'pat-token',
        COPILOT_GITHUB_TOKEN: 'copilot-token',
        OTHER_HOST_VAR: 'safe',
      };

      const env = buildChildEnv({ backend: 'agy', source: host, readOnly: true });

      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(env.GITHUB_PAT).toBeUndefined();
      expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(env.PATH).toBe('/bin');
    });

    it('ignores GitHub tokens passed in extraEnv and throws fail-closed on attempt to leak', () => {
      const host: NodeJS.ProcessEnv = { PATH: '/bin' };

      const env = buildChildEnv({
        backend: 'agy',
        source: host,
        extraEnv: { GITHUB_TOKEN: 'sneaky-token', SAFE_VAR: 'hello' },
        readOnly: true,
      });

      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.SAFE_VAR).toBe('hello');
    });

    it('disables CEZ_AGENT_ENV_FULL bypass in readOnly mode', () => {
      const host: NodeJS.ProcessEnv = {
        PATH: '/bin',
        GITHUB_TOKEN: 'secret-token',
        CEZ_AGENT_ENV_FULL: '1',
      };

      const env = buildChildEnv({ backend: 'agy', source: host, readOnly: true });
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });
  });

  describe('2. Read-only isolation setup & fail-closed behavior', () => {
    it('creates isolated GH_CONFIG_DIR and disables git credential manager without touching workspace ACLs', () => {
      const isolation = prepareReadOnlyIsolation();
      try {
        expect(isolation.env.GH_CONFIG_DIR).toBeDefined();
        expect(isolation.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
        expect(isolation.env.GIT_CONFIG_VALUE_0).toBe('');
        expect(isolation.env.GIT_CONFIG_KEY_1).toBe('remote.origin.pushurl');
        expect(isolation.env.GIT_CONFIG_VALUE_1).toBe('DISABLED_READ_ONLY_REVIEW');
        expect(isolation.env.GIT_TERMINAL_PROMPT).toBe('0');
      } finally {
        isolation.cleanup();
      }
    });

    it('cleans up temporary isolation directories safely after completion', () => {
      const isolation = prepareReadOnlyIsolation();
      const tempPath = isolation.env.GH_CONFIG_DIR!;
      expect(tempPath).toBeDefined();
      expect(statSync(tempPath).isDirectory()).toBe(true);

      isolation.cleanup();
      expect(() => statSync(tempPath)).toThrow();
    });
  });

  describe('3. Workspace integrity & ACL preservation', () => {
    it('preserves existing file permissions and does NOT mutate ACLs', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'cez-acl-check-'));
      const testFile = join(testDir, 'sample.txt');
      writeFileSync(testFile, 'initial content', 'utf8');
      // The cockpit may place tmpdir inside its own checkout. Isolate this test
      // from that ancestor repo and compare against an explicit git baseline.
      const git = (...args: string[]) => execFileSync('git', args, { cwd: testDir, stdio: 'ignore' });
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline');
      const baseline = getWorkspaceGitSnapshot(testDir);
      expect(baseline).toBeDefined();

      const statBefore = statSync(testFile);

      // Verify that verifyWorkspaceIntegrity reads cleanly without touching file
      const integrity = verifyWorkspaceIntegrity(testDir, baseline);
      expect(integrity.clean).toBe(true);

      const statAfter = statSync(testFile);
      expect(statAfter.mode).toBe(statBefore.mode);

      rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe('4. Tool and mutation interception', () => {
    it('MUTATING_TOOL_NAMES contains all mutating tools', () => {
      expect(MUTATING_TOOL_NAMES.has('write_to_file')).toBe(true);
      expect(MUTATING_TOOL_NAMES.has('replace_file_content')).toBe(true);
      expect(MUTATING_TOOL_NAMES.has('multi_replace_file_content')).toBe(true);
      expect(MUTATING_TOOL_NAMES.has('sed_file')).toBe(true);
      expect(MUTATING_TOOL_NAMES.has('notebook_edit')).toBe(true);
    });

    it('AgyCliRunner rejects execution fail-closed when bin is not found', async () => {
      const runner = new AgyCliRunner({ bin: '/nonexistent/path/to/agy-nonexistent' });
      await expect(
        runner.run({ userPrompt: 'test', cwd: process.cwd(), readOnly: true }),
      ).rejects.toThrow(/not found/);
    });  });

  describe('5. Checkout change detection, timeout, cancel (fake agy)', () => {
    const FAKE_AGY = fileURLToPath(new URL('./__fixtures__/fake-agy.mjs', import.meta.url));
    const fakeRunner = (timeoutMs = 30_000) =>
      new AgyCliRunner({ bin: process.execPath, binArgs: [FAKE_AGY], timeoutMs });
    const repos: string[] = [];
    const makeRepo = () => {
      const repo = mkdtempSync(join(tmpdir(), 'cez-agy-ro-'));
      repos.push(repo);
      const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
      g('init', '-q');
      g('config', 'core.autocrlf', 'false');
      writeFileSync(join(repo, 'tracked.txt'), 'v1\n');
      g('add', '.');
      g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      return repo;
    };
    afterEach(() => {
      for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
    });

    it('snapshot sees untracked files and new commits; git failure after baseline is not clean', () => {
      const repo = makeRepo();
      const base = getWorkspaceGitSnapshot(repo);
      expect(base).toMatch(/^HEAD [0-9a-f]{40}/);
      writeFileSync(join(repo, 'new.txt'), 'x');
      expect(verifyWorkspaceIntegrity(repo, base).clean).toBe(false);
      rmSync(join(repo, 'new.txt'));
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
      expect(verifyWorkspaceIntegrity(repo, base).clean).toBe(false);
      expect(getWorkspaceGitSnapshot(join(repo, 'missing-dir'))).toBeUndefined();
      expect(verifyWorkspaceIntegrity(join(repo, 'missing-dir'), base).clean).toBe(false);
    });

    async function recoveryRun(overrides: Record<string, string> = {}, posts: string[] = [], bodies: string[] = []) {
      const repo = makeRepo();
      if (!overrides.FAKE_AGY_NO_AGENTS_FILE) {
        writeFileSync(join(repo, 'AGENTS.md'), 'Review instructions\n');
      }
      mkdirSync(join(repo, 'src'));
      if (overrides.TEST_LINK_TARGET) symlinkSync(overrides.TEST_LINK_TARGET, join(repo, 'link'), 'junction');
      writeFileSync(join(repo, 'src/models.ts'), 'export type Model = string;\n');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'context');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
      if (overrides.FAKE_AGY_REQUIRED_README) writeFileSync(join(repo, 'README.md'), 'Mandatory changed document\n');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'change');
      const head = git('rev-parse', 'HEAD');
      const diff = `git diff ${base} ${head}`;
      const forged = `git diff ${head} ${head}`;
      const prompt = overrides.FAKE_AGY_FORGED_CONTEXT ? `The PR diff is: ${forged}\nThe PR diff is: ${diff}` : `The PR diff is: ${diff}`;
      const notes: string[] = [];
      const result = await fakeRunner().run({ userPrompt: prompt, cwd: repo, readOnly: true,
        systemPrompt: 'MAIN_IMPLEMENTATION_SKILL read main checkout handoff', additionalDirectories: [join(repo, '..')],
        ...(overrides.TEST_CONTINUE ? { sessionId: 'prior-conversation' } : {}),
        prReview: overrides.FAKE_AGY_NO_METADATA ? undefined : { mergeBase: base, headSha: head },
        env: { FAKE_AGY_MODE: 'recovery', FAKE_AGY_DIFF: overrides.FAKE_AGY_FORGED_CONTEXT ? forged : diff, ...overrides } },
        (event) => { if (event.type === 'note') notes.push(event.message); });
      // Compose the real runner and real publisher with fake gh only: never a network call.
      const publish = await publishReviewFromRun({ repoRoot: repo, text: result.text, runner: 'agy',
        target: { repo: 'metelskiwiktor/cezar', number: 99, headSha: head, baseRef: 'origin/main', mergeBase: base },
        run: async (_bin, args) => {
          if (args.includes('POST')) {
            posts.push(args.join(' '));
            bodies.push((JSON.parse(readFileSync(args.at(-1)!, 'utf8')) as { body: string }).body);
          }
          if (overrides.FAKE_PUBLISH_MODE === 'stale' && args.includes('.head.sha')) return 'f'.repeat(40);
          if (overrides.FAKE_PUBLISH_MODE === 'duplicate' && args.includes('--paginate')) return prReviewMarker(99, head);
          return args.includes('.head.sha') ? head : '';
        } });
      return { ...result, publish, notes, head };
    }

    it('accepts read_file Path reads as pinned diff and changed-file evidence', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_READ_FILE: '1', FAKE_AGY_SKIP_ERROR: '1' }, posts)).resolves.toMatchObject({ publish: { status: 'published' } });
      expect(posts).toHaveLength(1);
    });

    it('read_file Path cannot escape the assigned checkout', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_READ_FILE: '1', FAKE_AGY_MISSING_PATH: '../outside/README.md', FAKE_AGY_ERROR: '' }, posts)).rejects.toThrow(/scope violation/);
      expect(posts).toEqual([]);
    });

    it('read_file permission denial remains fatal', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_READ_FILE: '1', FAKE_AGY_ERROR: 'permission denied' }, posts)).rejects.toThrow(/permission/i);
      expect(posts).toEqual([]);
    });

    // Live run 5a3f5ec0: agy's own permission step rejects a relative read_file path before the
    // tool runs, so the runner serves the read from the pinned checkout instead (same turn flow
    // as a trusted check), and publication proceeds through the usual evidence gates.
    describe('relative read paths (agy requires absolute ones)', () => {
      const rel = (overrides: Record<string, string> = {}, posts: string[] = []) =>
        recoveryRun({ FAKE_AGY_MODE: 'relative-read', ...overrides }, posts);

      it.each([
        ['read_file Path', { FAKE_AGY_REL_PATH: 'tracked.txt' }],
        ['view_file AbsolutePath, ./ prefix', { FAKE_AGY_REL_TOOL: 'view_file', FAKE_AGY_REL_PATH: './tracked.txt' }],
        ['a Windows-style separator inside the checkout', { FAKE_AGY_REL_PATH: 'src\\..\\tracked.txt' }],
        ['Continue (prior session id)', { TEST_CONTINUE: '1' }],
      ])('serves the read and publishes: %s', async (_name, overrides) => {
        const posts: string[] = [];
        const run = await rel(overrides, posts);
        expect(run.publish).toMatchObject({ status: 'published' });
        expect(posts).toHaveLength(1);
        expect(run.notes).toEqual(expect.arrayContaining([expect.stringContaining('Served relative read of tracked.txt')]));
        expect(run.text).toContain('Recommendation: APPROVE');
      });

      it('the changed file only counts as opened once the model reads the served copy', async () => {
        const posts: string[] = [];
        await expect(rel({ FAKE_AGY_OMIT_SERVED_READ: '1' }, posts)).rejects.toThrow(/no changed file was opened/);
        expect(posts).toEqual([]);
      });

      it.each([
        ['parent traversal', '../outside/README.md'],
        ['traversal that re-enters by name', 'src/../../cez-other-checkout/tracked.txt'],
        ['drive-relative', 'C:tracked.txt'],
        ['root-relative backslash', '\\tracked.txt'],
        ['root-relative slash', '/tracked.txt'],
        ['UNC', '\\\\host\\share\\tracked.txt'],
      ])('does not serve %s', async (_name, path) => {
        const posts: string[] = [];
        await expect(rel({ FAKE_AGY_REL_PATH: path }, posts)).rejects.toThrow(/scope violation/);
        expect(posts).toEqual([]);
      });

      it('does not serve a path through a symlink/junction that leaves the checkout', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'cez-agy-outside-'));
        writeFileSync(join(outside, 'secret.txt'), 'secret\n');
        repos.push(outside);
        const posts: string[] = [];
        await expect(rel({ FAKE_AGY_REL_PATH: 'link/secret.txt', TEST_LINK_TARGET: outside }, posts)).rejects.toThrow(/scope violation/);
        expect(posts).toEqual([]);
      });

      it('serves exactly the requested line range, capped, and refuses binary/oversized files', () => {
        const repo = makeRepo();
        writeFileSync(join(repo, 'ten.txt'), Array.from({ length: 10 }, (_, i) => `row${i + 1}`).join('\n') + '\n');
        writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 2]));
        expect(serveCheckoutRead(repo, join(repo, 'ten.txt'), 2, 3)).toEqual({ first: 2, last: 3, text: 'Cezar served read of ten.txt, lines 2-3 of 10\n2: row2\n3: row3\n' });
        expect(serveCheckoutRead(repo, join(repo, 'ten.txt'), 9, 50)).toMatchObject({ first: 9, last: 10 });
        expect(serveCheckoutRead(repo, join(repo, 'ten.txt'), 11, 12)).toHaveProperty('error');
        expect(serveCheckoutRead(repo, join(repo, 'bin.dat'))).toEqual({ error: 'bin.dat is a binary file' });
        expect(serveCheckoutRead(repo, join(repo, 'nope.txt'))).toHaveProperty('error');
      });
    });

    it('recovers a guessed index path only with corrected read and complete review evidence', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({}, posts)).resolves.toMatchObject({ text: expect.stringContaining('Recommendation: APPROVE'), publish: { status: 'published' } });
      expect(posts).toHaveLength(1);
    });

    it('continues after an optional checkout README is missing, with complete mandatory evidence', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: 'docs/README.md' }, posts)).resolves.toMatchObject({ publish: { status: 'published' }, notes: expect.arrayContaining([expect.stringContaining('mandatory checkout evidence is complete')]) });
      expect(posts).toHaveLength(1);
    });

    it('continues after an optional checkout ADR document is missing, with complete mandatory evidence (run 2ac98267)', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: 'docs/adr/0018-shared-preview-ota-state.md' }, posts)).resolves.toMatchObject({ publish: { status: 'published' } });
      expect(posts).toHaveLength(1);
    });

    it('launches the real runner with checkout-only args and without journal env', async () => {
      await expect(recoveryRun({ FAKE_AGY_ASSERT_PR_SCOPE: '1', CEZ_HANDOFF_FILE: 'C:/main/run.handoff.md',
        CEZ_TODOS_FILE: 'C:/main/todos.json', CEZ_BIN: 'C:/runtime/index.js', CEZ_TREE_DIR: 'C:/main/tree' })).resolves.toMatchObject({ publish: { status: 'published' } });
    });

    // One failed in-scope read does not void a review whose mandatory evidence (pinned diff,
    // AGENTS.md, an affected file, finished calls) is complete; the run says so in a note.
    it.each<[string, Record<string, string>]>([
      ['a changed README reported ENOENT (its diff is read)', { FAKE_AGY_REQUIRED_README: '1', FAKE_AGY_MISSING_PATH: 'README.md' }],
      ['more than two optional misses', { FAKE_AGY_MISSING_PATH: 'docs/README.md', FAKE_AGY_EXTRA_MISSES: '2' }],
      ['a missing skill file', { FAKE_AGY_MISSING_PATH: '.agents/skills/README.md' }],
      ['a guessed index path never corrected', { FAKE_AGY_OMIT: 'correction' }],
      ['a transient miss on a changed file read afterwards', { FAKE_AGY_MISSING_PATH: 'tracked.txt' }],
      ['a transient miss on AGENTS.md read afterwards', { FAKE_AGY_MISSING_PATH: 'AGENTS.md' }],
      ['an arbitrary missing source', { FAKE_AGY_MISSING_PATH: 'src/unrelated.ts' }],
      ['an unknown read failure', { FAKE_AGY_ERROR: 'unknown read failure' }],
    ])('a single non-mandatory inspection error does not void the review: %s', async (_name, overrides) => {
      const posts: string[] = [];
      await expect(recoveryRun(overrides, posts)).resolves.toMatchObject({
        publish: { status: 'published' },
        notes: expect.arrayContaining([expect.stringContaining('mandatory checkout evidence is complete')]),
      });
      expect(posts).toHaveLength(1);
    }, 20_000);

    it('does not emit the mandatory checkout evidence note on a plain read-only analysis run without PR review context', async () => {
      const repo = makeRepo();
      const notes: string[] = [];
      await expect(
        fakeRunner().run(
          {
            userPrompt: 'analyze how models work',
            cwd: repo,
            readOnly: true,
            env: { FAKE_AGY_MODE: 'recovery', FAKE_AGY_MISSING_PATH: 'docs/README.md' },
          },
          (event) => {
            if (event.type === 'note') notes.push(event.message);
          },
        ),
      ).resolves.toBeDefined();
      expect(notes.some((n) => n.includes('mandatory checkout evidence is complete'))).toBe(false);
    });

    it('fails closed on an outside inspection even if the provider reports success', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: '../outside/README.md', FAKE_AGY_ERROR: '' }, posts)).rejects.toThrow(/scope violation/);
      expect(posts).toEqual([]);
    });

    it('rejects an external handoff read as a scope violation', async () => {
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: '../runs/id/handoff.md' })).rejects.toThrow(/evidence/);
    });

    it('stops immediately on permission denial before the agent can bypass it', async () => {
      const calls: string[] = [];
      await expect(fakeRunner().run({ userPrompt: 'review', cwd: makeRepo(), readOnly: true,
        env: { FAKE_AGY_MODE: 'denial' } }, (e) => { if (e.type === 'tool-call') calls.push(e.tool); })).rejects.toThrow(/Tool permission error.*Review stopped/);
      expect(calls).toEqual(['view_file']);
    });

    it.each<[string, RegExp]>([
      ['changed', /Review evidence is incomplete: no changed file was opened\. Nothing is published/],
      ['trusted-diff', /Review evidence is incomplete: the full pinned PR diff was not read\. Nothing is published/],
    ])('optional ENOENT never substitutes for critical %s evidence', async (missing, error) => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: 'docs/README.md', FAKE_AGY_OMIT: missing }, posts)).rejects.toThrow(error);
      expect(posts).toEqual([]);
    });

    it('requires a changed file to be opened even without any inspection error', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_SKIP_ERROR: '1', FAKE_AGY_OMIT: 'changed' }, posts)).rejects.toThrow(/evidence/);
      expect(posts).toEqual([]);
    });

    // Live run f1082729 (Tabnote #37): 28 good reads, one failed read of a file outside the PR,
    // AGENTS.md never opened, and a clean APPROVE failed the whole run. Now it publishes once,
    // at the pinned HEAD, with the gaps disclosed by Cezar.
    it('publishes once with one failed read in 29 and AGENTS.md unread, disclosing both (live run f1082729)', async () => {
      const posts: string[] = [];
      const bodies: string[] = [];
      const run = await recoveryRun({ FAKE_AGY_MISSING_PATH: '.github/workflows/release.yml', FAKE_AGY_OMIT: 'agents', FAKE_AGY_EXTRA_READS: '25' }, posts, bodies);
      expect(run.toolCalls.filter((c) => c.name === 'view_file')).toHaveLength(29);
      expect(run.publish).toEqual({ status: 'published' });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain('repos/metelskiwiktor/cezar/issues/99/comments');
      const body = bodies[0]!;
      expect(body).toContain('Recommendation: APPROVE');
      expect(body).toContain('- Not verified: 1 file read(s) failed: .github/workflows/release.yml');
      expect(body).toContain('- Not verified: AGENTS.md was not read');
      expect(body).toContain(prReviewMarker(99, run.head));
      expect(run.notes).toEqual(expect.arrayContaining([expect.stringContaining('non-critical gaps')]));
    });

    it('a second publication of the same pinned HEAD is skipped, never posted twice', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_OMIT: 'agents', FAKE_PUBLISH_MODE: 'duplicate' }, posts)).resolves.toMatchObject({ publish: { status: 'skipped-duplicate' } });
      expect(posts).toEqual([]);
    });

    it('allows review to succeed and publish when AGENTS.md does not exist in checkout', async () => {
      const posts: string[] = [];
      await expect(
        recoveryRun({ FAKE_AGY_NO_AGENTS_FILE: '1', FAKE_AGY_OMIT: 'agents' }, posts),
      ).resolves.toMatchObject({ publish: { status: 'published' } });
      expect(posts).toHaveLength(1);
    });

    it('forgives ENOENT when agent attempts to read missing AGENTS.md in repo without it', async () => {
      const posts: string[] = [];
      await expect(
        recoveryRun(
          {
            FAKE_AGY_NO_AGENTS_FILE: '1',
            FAKE_AGY_OMIT: 'agents',
            FAKE_AGY_MISSING_PATH: 'AGENTS.md',
            FAKE_AGY_ERROR: 'ENOENT: no such file or directory',
          },
          posts,
        ),
      ).resolves.toMatchObject({
        publish: { status: 'published' },
        notes: expect.arrayContaining([expect.stringContaining('mandatory checkout evidence is complete')]),
      });
      expect(posts).toHaveLength(1);
    });

    it('uses the Cezar-pinned complete diff instead of requiring a native Agy command', async () => {
      await expect(recoveryRun({ FAKE_AGY_SKIP_ERROR: '1', FAKE_AGY_OMIT: 'diff' })).resolves.toMatchObject({ publish: { status: 'published' } });
    });

    it.each([['stale', 'stale'], ['duplicate', 'skipped-duplicate']])('recovered review still honors %s publication guard', async (mode, status) => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_PUBLISH_MODE: mode! }, posts)).resolves.toMatchObject({ publish: { status } });
      expect(posts).toEqual([]);
    });

    describe('late provider "malformed function call" after a finished review (live run 2bb661b9)', () => {
      it('accepts the finished review only with complete evidence, runs no check unasked, and publishes once', async () => {
        const posts: string[] = [];
        const run = await recoveryRun({ FAKE_AGY_RESULT_ERROR: 'malformed' }, posts);
        expect(run).toMatchObject({ text: expect.stringContaining('Recommendation: APPROVE'), publish: { status: 'published' } });
        expect(run.notes.some((n) => /late provider function-call format error.*accepted/.test(n))).toBe(true);
        // No automatic `just test` (or any check) when the reviewer did not request one.
        expect(run.notes.some((n) => n.includes('Exit:'))).toBe(false);
        expect(posts).toHaveLength(1);
      });

      it.each([['stale', 'stale'], ['duplicate', 'skipped-duplicate']])('a recovered review still honors the %s publication guard', async (mode, status) => {
        const posts: string[] = [];
        await expect(recoveryRun({ FAKE_AGY_RESULT_ERROR: 'malformed', FAKE_PUBLISH_MODE: mode! }, posts)).resolves.toMatchObject({ publish: { status } });
        expect(posts).toEqual([]);
      });

      it.each<[string, Record<string, string>, RegExp]>([
        ['missing AGENTS.md evidence', { FAKE_AGY_OMIT: 'agents' }, /recovery refused: review evidence is incomplete/],
        ['missing pinned diff reads', { FAKE_AGY_OMIT: 'trusted-diff' }, /recovery refused: review evidence is incomplete/],
        ['an unfinished tool call', { FAKE_AGY_PENDING: '1' }, /recovery refused: review evidence is incomplete/],
        ['a failed tool call', { FAKE_AGY_ERROR: 'unknown read failure' }, /recovery refused|inspection/],
        ['no verdict line', { FAKE_AGY_FINAL_TEXT: 'Findings: none.' }, /recovery refused: the review text has 0 Recommendation lines/],
        ['two verdict lines', { FAKE_AGY_FINAL_TEXT: 'Recommendation: APPROVE\nRecommendation: CHANGES REQUESTED' }, /recovery refused: the review text has 2 Recommendation lines/],
        ['agy continuing after the error', { FAKE_AGY_AFTER_ERROR: '1' }, /recovery refused: agy continued after the error/],
      ])('fails closed without a POST on %s', async (_name, overrides, error) => {
        const posts: string[] = [];
        await expect(recoveryRun({ FAKE_AGY_RESULT_ERROR: 'malformed', ...overrides }, posts)).rejects.toThrow(error);
        expect(posts).toEqual([]);
      });

      it('never recovers a permission denial, even with the format error after it', async () => {
        const posts: string[] = [];
        await expect(recoveryRun({ FAKE_AGY_RESULT_ERROR: 'malformed', FAKE_AGY_ERROR: 'permission denied' }, posts)).rejects.toThrow(/permission/i);
        expect(posts).toEqual([]);
      });

      it('never recovers a generic provider error', async () => {
        const posts: string[] = [];
        await expect(recoveryRun({ FAKE_AGY_RESULT_ERROR: 'Internal provider error: quota exhausted' }, posts)).rejects.toThrow(/quota exhausted/);
        expect(posts).toEqual([]);
      });

      it('rejects a check request mixed into the final review instead of ignoring it', async () => {
        const posts: string[] = [];
        await expect(recoveryRun({ FAKE_AGY_FINAL_TEXT: 'CEZ_REVIEW_CHECK {"args":["just","test"],"reason":"x"}\nRecommendation: APPROVE' }, posts)).rejects.toThrow(/Invalid review check request/);
        expect(posts).toEqual([]);
      });
    });

    it('does not forgive an external path', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_MISSING_PATH: '../outside/index.ts' }, posts)).rejects.toThrow(/scope violation/);
      expect(posts).toEqual([]);
    });

    it('a guessed path never corrected still refuses the stricter late-format-error recovery', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_RESULT_ERROR: 'malformed', FAKE_AGY_OMIT: 'correction' }, posts)).rejects.toThrow(/recovery refused/);
      expect(posts).toEqual([]);
    });

    it('publishes a review with an unfinished side read, disclosing it', async () => {
      const posts: string[] = [];
      const run = await recoveryRun({ FAKE_AGY_PENDING: '1' }, posts);
      expect(run).toMatchObject({ publish: { status: 'published' } });
      expect(run.text).toContain('- Not verified: 1 tool call(s) never reported a result');
      expect(posts).toHaveLength(1);
    });

    it('does not accept a forged empty diff in the task prompt as review evidence', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_FORGED_CONTEXT: '1', FAKE_AGY_OMIT: 'changed' }, posts)).rejects.toThrow(/evidence/);
      expect(posts).toEqual([]);
    });

    it('requires machine-owned target metadata rather than trusting the prompt', async () => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_NO_METADATA: '1' }, posts)).rejects.toThrow(/evidence/);
      expect(posts).toEqual([]);
    });

    it.each(['permission denied', 'EACCES: access denied', 'EPERM: operation not permitted', 'ENOENT: permission denied'])('does not recover %s', async (error) => {
      const posts: string[] = [];
      await expect(recoveryRun({ FAKE_AGY_ERROR: error }, posts)).rejects.toThrow();
      expect(posts).toEqual([]);
    });

    it('allows a local edit tool in a PR review: the worktree is scratch space', async () => {
      const posts: string[] = [];
      await recoveryRun({ FAKE_AGY_MUTATE: '1' }, posts).catch((e: unknown) => { expect(String(e)).not.toMatch(/mutating tool/); });
    });

    it('read-only run that writes into the checkout fails', async () => {
      const repo = makeRepo();
      await expect(
        fakeRunner().run({ userPrompt: 'review', cwd: repo, readOnly: true, env: { FAKE_AGY_MODE: 'write' } }),
      ).rejects.toThrow(/checkout changed/);
    });

    it('the same write is allowed for a normal (non-read-only) task', async () => {
      const repo = makeRepo();
      await expect(
        fakeRunner().run({ userPrompt: 'implement', cwd: repo, env: { FAKE_AGY_MODE: 'write' } }),
      ).resolves.toMatchObject({ text: '' });
    });

    it('streamed text deltas reach the engine as one whole message, not one line per delta', async () => {
      const repo = makeRepo();
      const texts: string[] = [];
      const result = await fakeRunner().run({ userPrompt: 'r', cwd: repo, readOnly: true, env: { FAKE_AGY_MODE: 'deltas' } }, (e) => {
        if (e.type === 'text') texts.push(e.text);
      });
      expect(texts).toEqual(['Findings: none.\nRecommendation: APPROVE']);
      expect(result.text).toBe('Findings: none.\nRecommendation: APPROVE');
    });

    it('clean read-only run succeeds; non-zero exit fails', async () => {
      const repo = makeRepo();
      await expect(fakeRunner().run({ userPrompt: 'r', cwd: repo, readOnly: true })).resolves.toBeDefined();
      await expect(
        fakeRunner().run({ userPrompt: 'r', cwd: repo, readOnly: true, env: { FAKE_AGY_MODE: 'fail' } }),
      ).rejects.toThrow(/exited with code 3/);
    });

    it('read-only timeout kills the process and fails the run', async () => {
      const repo = makeRepo();
      const started = Date.now();
      await expect(
        fakeRunner(1_500).run({ userPrompt: 'r', cwd: repo, readOnly: true, env: { FAKE_AGY_MODE: 'hang' } }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it('cancel (interrupt) terminates a hanging run and settles', async () => {
      const repo = makeRepo();
      const session = fakeRunner().startSession(
        { userPrompt: 'r', cwd: repo, readOnly: true, env: { FAKE_AGY_MODE: 'hang' } },
        undefined,
        { autoEndAfterFirstTurn: true },
      );
      await new Promise((r) => setTimeout(r, 800));
      const pid = session.pid;
      expect(pid).toBeDefined();
      session.interrupt();
      await session.result.catch(() => undefined);
      expect(() => process.kill(pid!, 0)).toThrow();
    });
  });

  describe('6. killAgyTree', () => {
    it('uses taskkill /T /F on Windows and child.kill elsewhere', () => {
      const calls: unknown[][] = [];
      const run = ((...args: unknown[]) => { calls.push(args); return {} as never; }) as never;
      const kills: string[] = [];
      const child = { pid: 42, kill: (s?: NodeJS.Signals | number) => { kills.push(String(s)); return true; } };
      killAgyTree(child, 'SIGTERM', 'win32', run);
      expect(calls[0]?.[0]).toBe('taskkill');
      expect(calls[0]?.[1]).toEqual(['/pid', '42', '/T', '/F']);
      killAgyTree(child, 'SIGKILL', 'linux', run);
      expect(kills).toEqual(['SIGKILL']);
    });
  });
});
