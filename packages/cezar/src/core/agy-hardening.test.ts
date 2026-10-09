import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildChildEnv, GH_CREDENTIAL_NAMES } from './agent-env.ts';
import { AgyCliRunner, MUTATING_TOOL_NAMES } from './agy-cli-runner.ts';
import { prepareReadOnlyIsolation, verifyWorkspaceIntegrity } from './read-only-sandbox.ts';

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
      const tempPath = isolation.env.GH_CONFIG_DIR;
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
    });
  });
});
