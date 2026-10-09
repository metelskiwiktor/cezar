/**
 * Antigravity CLI runner (`agy`) — headless print mode over `stream-json`.
 *
 * Runs Google Antigravity CLI with Gemini models (defaulting to `gemini-3.8-flash-high`)
 * under the user's Google AI Pro subscription without requiring a paid Gemini API key.
 *
 * Emits v1 `AgentEvent`s and, when `opts.onUiEvent` is set, protocol v2
 * `UiEvent`s alongside.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import {
  createAgyUiState,
  mapAgyMessage,
  mapAgyStreamEvent,
  type AgyUiMapperState,
} from './agy-ui-mapper.ts';

export const DEFAULT_AGY_TIMEOUT_MS = 30 * 60_000;
export const AGY_KILL_GRACE_MS = 10_000;
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-high';

export interface AgyCliRunnerOptions {
  bin?: string;
  timeoutMs?: number;
}

export interface BuildAgyArgsInput {
  userPrompt: string;
  systemPrompt?: string;
  model?: string;
  sessionId?: string;
  resume?: boolean;
  additionalDirectories?: string[];
}

/** CLI argv for headless print mode. */
export function buildAgyArgs(input: BuildAgyArgsInput): string[] {
  const args = ['--output-format', 'stream-json', '--mode', 'accept-edits'];

  const model = input.model?.trim() || DEFAULT_AGY_MODEL;
  args.push('--model', model);

  if ((input.resume || input.sessionId) && input.sessionId) {
    args.push('--conversation', input.sessionId);
  }

  if (input.additionalDirectories) {
    for (const dir of input.additionalDirectories) {
      if (dir.trim()) args.push('--add-dir', dir.trim());
    }
  }

  const prompt = prependSystemPrompt(input.systemPrompt, input.userPrompt);
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
  private readonly timeoutMs: number;
  private lastSession: AgentSession | null = null;

  constructor(opts: AgyCliRunnerOptions = {}) {
    this.bin = resolveAgyBin(opts.bin);
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

    const emit = (event: AgentEvent) => {
      if (event.type === 'text') textChunks.push(event.text);
      if (event.type === 'tool-call') {
        toolCalls.push({ id: event.id, name: event.tool, input: event.input });
      }
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'token-usage') tokensUsed = event.tokensUsed;
      if (event.type === 'error') resultError = event.message;
      onEvent?.(event);
    };

    const limitMs = spec.timeoutMs ?? this.timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const armTimeout = (child: ChildProcessWithoutNullStreams) => {
      if (limitMs > 0) {
        deadline = setTimeout(() => {
          timedOut = true;
          terminatedByCezar = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, AGY_KILL_GRACE_MS);
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
        additionalDirectories: spec.additionalDirectories,
      });

      const env = buildChildEnv({ backend: this.backend, extraEnv: spec.env });
      const [file, argv] = disclaimedCommand(this.bin, args, env);
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
        if (!timedOut) {
          /* premature close */
        }
      } finally {
        clearTimers();
      }

      const exitCode = await waitForExit(child);
      if (spawnFailed) throw spawnFailed;

      if (timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        onEvent?.({ type: 'error', message: `Antigravity agent timed out after ${mins}m and was killed` });
        return;
      }

      if (terminatedByCezar && isSignalTerminationExit(exitCode)) {
        onEvent?.({
          type: 'note',
          message: `Antigravity agent terminated by cezar (code ${exitCode})`,
        });
        return;
      }

      if (exitCode !== 0 && exitCode !== null) {
        const stderr = stderrChunks.join('').trim();
        const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
        const msg = `Antigravity agent exited with code ${exitCode}${detail}`;
        onEvent?.({ type: 'error', message: msg });
        throw new Error(msg);
      }

      if (resultError) throw new Error(resultError);
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
      try {
        currentChild?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
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
