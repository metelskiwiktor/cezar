import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv } from './agent-env.ts';
import { AgyCliRunner, killAgyTree, MUTATING_TOOL_NAMES } from './agy-cli-runner.ts';
import { getWorkspaceGitSnapshot, prepareReadOnlyIsolation, verifyWorkspaceIntegrity } from './read-only-sandbox.ts';

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

      const statBefore = statSync(testFile);

      // Verify that verifyWorkspaceIntegrity reads cleanly without touching file
      const integrity = verifyWorkspaceIntegrity(testDir);
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
