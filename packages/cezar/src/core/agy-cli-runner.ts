/**
 * Antigravity CLI runner (`agy`) — headless print mode over `stream-json`.
 *
 * Runs Google Antigravity CLI with Gemini models (defaulting to `gemini-3.8-flash-high`)
 * under the user's Google AI Pro subscription without requiring a paid Gemini API key.
 *
 * Emits v1 `AgentEvent`s and, when `opts.onUiEvent` is set, protocol v2
 * `UiEvent`s alongside.
 */

import { resolve } from 'node:path';
import { spawn as nodeSpawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { readNdjson } from './ndjson.ts';
import { resolveAgyBin } from './agy-bin.ts';
import { AgyReviewEvidence } from './agy-review-evidence.ts';
import {
  createAgyUiState,
  mapAgyMessage,
  mapAgyStreamEvent,
  type AgyUiMapperState,
} from './agy-ui-mapper.ts';
import {
  prepareReadOnlyIsolation,
  getWorkspaceGitSnapshot,
  verifyWorkspaceIntegrity,
} from './read-only-sandbox.ts';

export const DEFAULT_AGY_TIMEOUT_MS = 30 * 60_000;
export const AGY_KILL_GRACE_MS = 10_000;
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-high';

export const MUTATING_TOOL_NAMES = new Set([
  'write',
  'edit',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);

export const READ_INSPECTION_TOOL_NAMES = new Set([
  'read',
  'view_file',
  'grep',
  'grep_search',
  'find_by_name',
  'list_dir',
  'read_url_content',
  'read_browser_page',
]);

export const READ_ONLY_REVIEW_PROMPT =
  'IMPORTANT: You are running in strict READ-ONLY review mode. You MUST NOT create, edit, or modify any files, and you must not run mutating commands. You may only inspect files using view_file, grep_search, list_dir, and related inspection tools. Discover repository paths before opening them; do not guess module/index paths. For a prepared PR checkout, successfully read AGENTS.md, run the exact full PR diff command from the context, and use view_file on every surviving changed file before concluding the review. Report missing required files or denied access as incomplete review, never as approval.';

export function isReadOnlyTools(allowedTools?: string[]): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;
  const lower = allowedTools.map((t) => t.toLowerCase());
  return !lower.some((t) => MUTATING_TOOL_NAMES.has(t) || t === 'bash');
}

export function isPermissionError(result: string): boolean {
  const lower = result.toLowerCase();
  return (
    lower.includes('user denied permission') ||
    lower.includes('permission check failed') ||
    lower.includes('soft-denying') ||
    lower.includes('permission denied') ||
    /\b(eacces|eperm)\b|access (?:is )?denied|operation not permitted/.test(lower)
  );
}

export interface AgyCliRunnerOptions {
  bin?: string;
  /** Arguments placed before agy's own (e.g. a script when `bin` is an interpreter). Test seam. */
  binArgs?: string[];
  timeoutMs?: number;
}

export interface BuildAgyArgsInput {
  userPrompt: string;
  systemPrompt?: string;
  model?: string;
  sessionId?: string;
  resume?: boolean;
  cwd?: string;
  additionalDirectories?: string[];
  readOnly?: boolean;
  allowedTools?: string[];
}

/** CLI argv for headless print mode. */
export function buildAgyArgs(input: BuildAgyArgsInput): string[] {
  const readOnly = input.readOnly === true || isReadOnlyTools(input.allowedTools);
  const args = ['--output-format', 'stream-json', '--mode', 'accept-edits'];

  const model = input.model?.trim() || DEFAULT_AGY_MODEL;
  args.push('--model', model);

  if ((input.resume || input.sessionId) && input.sessionId) {
    args.push('--conversation', input.sessionId);
  }

  const dirs = new Set<string>();
  if (input.cwd?.trim()) dirs.add(resolve(input.cwd.trim()));
  if (input.additionalDirectories) {
    for (const dir of input.additionalDirectories) {
      if (dir.trim()) dirs.add(resolve(dir.trim()));
    }
  }
  for (const dir of dirs) {
    args.push('--add-dir', dir);
  }

  let systemPrompt = input.systemPrompt;
  if (readOnly) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${READ_ONLY_REVIEW_PROMPT}`
      : READ_ONLY_REVIEW_PROMPT;
  }

  const prompt = prependSystemPrompt(systemPrompt, input.userPrompt);
  args.push('-p', prompt);

  return args;
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found — install Google Antigravity CLI (\`agy\`) or set CEZ_AGY_BIN`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Terminate the agy process and anything it spawned. On Windows `child.kill()`
 * only ends the top process, so a `run_command` grandchild would survive;
 * `taskkill /T /F` takes the whole tree. Best-effort: errors are ignored.
 */
export function killAgyTree(
  child: Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
): void {
  try {
    if (platform === 'win32' && child.pid) {
      run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const fin = (code: number | null) => resolve(code);
    child.once('close', fin);
    child.once('exit', fin);
    child.once('error', () => fin(child.exitCode ?? null));
  });
}

export class AgyCliRunner implements AgentRunner {
  readonly backend = 'agy' as const;

  private readonly bin: string;
  private readonly binArgs: string[];
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: AgyCliRunnerOptions = {}) {
    this.bin = resolveAgyBin(opts.bin);
    this.binArgs = opts.binArgs ?? [];
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    let currentChild: ChildProcessWithoutNullStreams | null = null;
    let sessionId = spec.sessionId;
    let open = true;
    let terminatedByCezar = false;
    let timedOut = false;
    let resultError: string | undefined;

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    const stderrChunks: string[] = [];

    let uiState: AgyUiMapperState = createAgyUiState({ fallbackSessionId: spec.sessionId });
    const emitUi = (map: (state: AgyUiMapperState) => { events: unknown[]; state: AgyUiMapperState }): void => {
      try {
        const mapped = map(uiState);
        uiState = mapped.state;
        if (opts.onUiEvent) {
          for (const event of mapped.events as any[]) opts.onUiEvent(event);
        }
      } catch {
        // v2 mapping is best-effort
      }
    };

    const readOnly = spec.readOnly === true || isReadOnlyTools(spec.allowedTools);

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const armTimeout = (child: ChildProcessWithoutNullStreams) => {
      if (limitMs > 0) {
        deadline = setTimeout(() => {
          timedOut = true;
          terminatedByCezar = true;
          killAgyTree(child);
          killTimer = setTimeout(() => killAgyTree(child, 'SIGKILL'), AGY_KILL_GRACE_MS);
          killTimer.unref?.();
        }, limitMs);
        deadline.unref?.();
      }
    };

    const clearTimers = () => {
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
    };

    const runTurn = async (userPrompt: string, systemPrompt?: string, resumeSessionId?: string): Promise<void> => {
      const args = buildAgyArgs({
        userPrompt,
        systemPrompt,
        model: spec.model,
        sessionId: resumeSessionId,
        resume: resumeSessionId !== undefined,
        cwd: spec.cwd,
        additionalDirectories: spec.additionalDirectories,
        readOnly,
        allowedTools: spec.allowedTools,
      });

      let isolationCleanup: (() => void) | undefined;
      let env: NodeJS.ProcessEnv;

      if (readOnly) {
        const isolation = prepareReadOnlyIsolation();
        isolationCleanup = isolation.cleanup;
        try {
          env = buildChildEnv({
            backend: this.backend,
            extraEnv: { ...(spec.env ?? {}), ...isolation.env },
            readOnly: true,
          });
        } catch (err) {
          isolationCleanup();
          throw err;
        }
      } else {
        env = buildChildEnv({ backend: this.backend, extraEnv: spec.env, readOnly: false });
      }

      // Baseline of HEAD + every tracked/untracked change. Outside a git checkout
      // there is nothing to compare against, so the check is skipped (noted).
      const initialSnapshot = readOnly && spec.cwd ? getWorkspaceGitSnapshot(spec.cwd) : undefined;
      if (readOnly && initialSnapshot === undefined) {
        onEvent?.({ type: 'note', message: 'read-only run outside a git checkout — change detection skipped' });
      }

      try {
        const [file, argv] = disclaimedCommand(this.bin, [...this.binArgs, ...args], env);
        const child = nodeSpawn(file, argv, { cwd: spec.cwd, env });
        currentChild = child;

        let spawnFailed: Error | null = null;
        child.on('error', (err: NodeJS.ErrnoException) => {
          spawnFailed = wrapSpawnError(err, this.bin);
        });

        child.stderr.on('data', (buf: Buffer) => {
          stderrChunks.push(buf.toString('utf8'));
        });

        armTimeout(child);

        let inspectionCalls = 0;
        let inspectionErrors = 0;
        let recoverableErrors = 0;
        const evidence = new AgyReviewEvidence(spec);
        let permissionDeniedError: string | null = null;
        const callToolNames = new Map<string, string>();

        // agy streams text as deltas, but a `text` event is one whole message to the engine
        // (it joins them with newlines): buffer consecutive deltas and forward them as one
        // message, before the next non-text event and at the end of the stream.
        let pendingText = '';
        const flushText = () => {
          if (!pendingText) return;
          const text = pendingText;
          pendingText = '';
          onEvent?.({ type: 'text', text });
        };
        const emit = (event: AgentEvent) => {
          if (event.type === 'text') {
            textChunks.push(event.text);
            pendingText += event.text;
            return;
          }
          flushText();
          if (event.type === 'tool-call') {
            callToolNames.set(event.id, event.tool);
            toolCalls.push({ id: event.id, name: event.tool, input: event.input });
            evidence.call({ id: event.id, name: event.tool, input: event.input });

            // Best-effort tripwire, not a boundary: the event may arrive after the
            // tool already ran. The hard check is the workspace snapshot below.
            if (readOnly && !resultError && MUTATING_TOOL_NAMES.has(event.tool.toLowerCase())) {
              terminatedByCezar = true;
              resultError = `Read-only review violation: mutating tool "${event.tool}" is not allowed`;
              onEvent?.({ type: 'error', message: resultError });
              killAgyTree(child);
            }
          }
          if (event.type === 'tool-result') {
            if (evidence.result(event.toolCallId, event.isError === true, event.result)) recoverableErrors++;
            const toolName = callToolNames.get(event.toolCallId)?.toLowerCase() ?? '';
            if (READ_INSPECTION_TOOL_NAMES.has(toolName)) {
              inspectionCalls++;
              if (event.isError) inspectionErrors++;
            }
            if (event.isError && isPermissionError(event.result)) {
              permissionDeniedError = event.result;
            }
          }
          if (event.type === 'session') sessionId = event.sessionId;
          if (event.type === 'token-usage') tokensUsed = event.tokensUsed;
          if (event.type === 'error') resultError = event.message;
          onEvent?.(event);
        };

        try {
          for await (const line of readNdjson(child.stdout)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            emitUi((state) => mapAgyMessage(parsed, state));
            for (const event of mapAgyStreamEvent(parsed)) emit(event);
          }
        } catch {
          /* premature stdout close — the exit code below decides */
        } finally {
          clearTimers();
          flushText();
        }

        const exitCode = await waitForExit(child);
        if (spawnFailed) throw spawnFailed;

        // Checked on every exit path (incl. timeout and cancel): a read-only run
        // that changed the checkout must never settle as a clean review.
        if (readOnly && initialSnapshot !== undefined && spec.cwd) {
          const integrity = verifyWorkspaceIntegrity(spec.cwd, initialSnapshot);
          if (!integrity.clean) {
            const msg = `Read-only review violation: the checkout changed during the run: ${integrity.details}`;
            onEvent?.({ type: 'error', message: msg });
            throw new Error(msg);
          }
        }

        if (timedOut) {
          const mins = Math.round((limitMs / 60_000) * 10) / 10;
          const msg = `Antigravity agent timed out after ${mins}m and was killed`;
          onEvent?.({ type: 'error', message: msg });
          // A read-only review must fail, not settle with a partial verdict.
          if (readOnly) throw new Error(msg);
          return;
        }

        if (terminatedByCezar && resultError) {
          throw new Error(resultError);
        }

      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `Antigravity agent terminated by cezar (code ${exitCode})`,
        });
        return;
      }

      if (permissionDeniedError) {
        const msg = `Tool permission error: ${permissionDeniedError}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (readOnly && ((inspectionErrors > 0 && (inspectionErrors !== recoverableErrors || !evidence.complete())) ||
          (evidence.hasContext && !evidence.complete()))) {
        const msg = `Tool execution failure: ${inspectionErrors} file inspection attempt(s) failed out of ${inspectionCalls}. Cannot complete review without unhindered file access and complete review evidence.`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `Antigravity agent exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (resultError) throw new Error(resultError);
    } finally {
      if (isolationCleanup) {
        isolationCleanup();
      }
    }
  };

    let turnQueue: Promise<void> = Promise.resolve();

    const result = (async (): Promise<AgentRunResult> => {
      try {
        await runTurn(spec.userPrompt, spec.systemPrompt, spec.sessionId);
      } finally {
        if (opts.autoEndAfterFirstTurn) {
          open = false;
        }
      }

      // If non-interactive or auto-end, emit done and return
      if (!open || opts.autoEndAfterFirstTurn) {
        open = false;
        onEvent?.({ type: 'done' });
        return {
          text: textChunks.join('').trim(),
          toolCalls,
          tokensUsed,
          sessionId,
        };
      }

      // If interactive, wait for queue to finish before final return
      await turnQueue;
      onEvent?.({ type: 'done' });
      return {
        text: textChunks.join('').trim(),
        toolCalls,
        tokensUsed,
        sessionId,
      };
    })();

    const interrupt = () => {
      terminatedByCezar = true;
      open = false;
      const child = currentChild;
      if (!child || child.exitCode != null) return;
      killAgyTree(child);
      const hard = setTimeout(() => killAgyTree(child, 'SIGKILL'), AGY_KILL_GRACE_MS);
      hard.unref?.();
      child.once('exit', () => clearTimeout(hard));
    };

    const session: AgentSession = {
      result,
      get pid() {
        return currentChild?.pid;
      },
      sendMessage(content: ContentBlock[]): boolean {
        if (!open) return false;
        const text = content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('\n')
          .trim();
        if (!text) return true;

        turnQueue = turnQueue.then(async () => {
          if (!open) return;
          await runTurn(text, undefined, sessionId);
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          onEvent?.({ type: 'error', message: `follow-up turn failed: ${msg}` });
        });

        return true;
      },
      end() {
        interrupt();
      },
      interrupt,
      get open() {
        return open;
      },
    };

    this.lastSession = session;
    return session;
  }
}
