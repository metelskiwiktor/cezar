import { describe, expect, it } from 'vitest';
import { createRunner } from './runner-factory.ts';
import {
  buildAgyArgs,
  AgyCliRunner,
  DEFAULT_AGY_MODEL,
} from './agy-cli-runner.ts';
import {
  createAgyUiState,
  mapAgyMessage,
  mapAgyStreamEvent,
} from './agy-ui-mapper.ts';

describe('buildAgyArgs', () => {
  it('builds stream-json print mode args with default gemini-3.8-flash-high model', () => {
    const args = buildAgyArgs({ userPrompt: 'Hello Gemini' });
    expect(args).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json', '--mode', 'accept-edits', '--model', DEFAULT_AGY_MODEL]),
    );
    expect(args.slice(-2)).toEqual(['-p', 'Hello Gemini']);
  });

  it('honors custom model override', () => {
    const args = buildAgyArgs({ userPrompt: 'Test', model: 'gemini-3.8-pro' });
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gemini-3.8-pro');
  });

  it('prepends system prompt when provided', () => {
    const args = buildAgyArgs({ userPrompt: 'Do task', systemPrompt: 'You are helpful' });
    expect(args.slice(-2)).toEqual(['-p', 'You are helpful\n\n---\n\nDo task']);
  });

  it('adds --conversation when resume / sessionId is provided', () => {
    const args = buildAgyArgs({
      userPrompt: 'Next turn',
      sessionId: 'conv-uuid-1234',
      resume: true,
    });
    expect(args).toEqual(
      expect.arrayContaining(['--conversation', 'conv-uuid-1234']),
    );
  });

  it('adds --add-dir for additional directories', () => {
    const args = buildAgyArgs({
      userPrompt: 'Check dirs',
      additionalDirectories: ['/path/one', '/path/two'],
    });
    expect(args).toEqual(
      expect.arrayContaining(['--add-dir', '/path/one', '--add-dir', '/path/two']),
    );
  });
});

describe('createRunner(agy)', () => {
  it('returns AgyCliRunner with backend "agy"', () => {
    const runner = createRunner('agy');
    expect(runner.backend).toBe('agy');
    expect(runner).toBeInstanceOf(AgyCliRunner);
  });
});

describe('mapAgyStreamEvent (v1 mapping)', () => {
  it('maps init event to session event', () => {
    const events = mapAgyStreamEvent({
      event: 'init',
      conversation_id: 'conv-123',
      init: { model: 'gemini-3.8-flash-high', cwd: '/test' },
    });
    expect(events).toEqual([{ type: 'session', sessionId: 'conv-123' }]);
  });

  it('maps agent_response text_delta to text event and usage', () => {
    const events = mapAgyStreamEvent({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Hello world',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    });
    expect(events).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'token-usage', tokensUsed: 120 },
    ]);
  });

  it('maps tool ACTIVE to tool-call and DONE to tool-result', () => {
    const activeEvents = mapAgyStreamEvent({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/foo/bar.ts' } },
      },
    });
    expect(activeEvents).toEqual([
      {
        type: 'tool-call',
        id: 'call_2',
        tool: 'view_file',
        input: { AbsolutePath: '/foo/bar.ts' },
      },
    ]);

    const doneEvents = mapAgyStreamEvent({
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/foo/bar.ts' },
          result: 'file content',
        },
      },
    });
    expect(doneEvents).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call_2',
        result: 'file content',
        isError: false,
      },
    ]);
  });

  it('maps result event with SUCCESS to token-usage and turn-end', () => {
    const events = mapAgyStreamEvent({
      event: 'result',
      result: {
        conversation_id: 'conv-123',
        status: 'SUCCESS',
        response: 'Finished',
        usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 },
      },
    });
    expect(events).toEqual([
      { type: 'token-usage', tokensUsed: 250 },
      { type: 'turn-end' },
    ]);
  });

  it('maps result event with ERROR to error event', () => {
    const events = mapAgyStreamEvent({
      event: 'result',
      result: {
        conversation_id: 'conv-123',
        status: 'ERROR',
        error: 'Model refused request',
      },
    });
    expect(events).toEqual([
      { type: 'error', message: 'Model refused request' },
      { type: 'turn-end' },
    ]);
  });
});

describe('mapAgyMessage (v2 mapping)', () => {
  it('maps init to session.started and turn.started', () => {
    const state = createAgyUiState();
    const mapping = mapAgyMessage(
      {
        event: 'init',
        conversation_id: 'conv-999',
        init: { model: 'gemini-3.8-flash-high', cwd: '/work' },
      },
      state,
    );

    expect(mapping.events).toEqual([
      {
        type: 'session.started',
        sessionId: 'conv-999',
        backend: 'agy',
        model: 'gemini-3.8-flash-high',
        cwd: '/work',
      },
      {
        type: 'turn.started',
        turnId: 'turn_1',
      },
    ]);
    expect(mapping.state.turnSeq).toBe(1);
    expect(mapping.state.sessionId).toBe('conv-999');
  });

  it('maps tool lifecycle in v2', () => {
    let state = createAgyUiState();
    const initRes = mapAgyMessage(
      { event: 'init', conversation_id: 'c1' },
      state,
    );
    state = initRes.state;

    const startTool = mapAgyMessage(
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { AbsolutePath: 'src/main.ts' } },
        },
      },
      state,
    );

    expect(startTool.events).toHaveLength(1);
    expect(startTool.events[0]).toMatchObject({
      type: 'item.started',
      item: {
        kind: 'tool',
        id: 'call_1',
        name: 'view_file',
        toolKind: 'read',
        status: 'running',
      },
    });

    const completeTool = mapAgyMessage(
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { result: 'file content' },
        },
      },
      startTool.state,
    );

    expect(completeTool.events).toHaveLength(1);
    expect(completeTool.events[0]).toMatchObject({
      type: 'item.completed',
      item: {
        kind: 'tool',
        id: 'call_1',
        status: 'completed',
        output: 'file content',
      },
    });
  });
});

describe('AgyCliRunner lifecycle', () => {
  it('rejects clearly when binary is not found', async () => {
    const runner = new AgyCliRunner({ bin: '/nonexistent/agy-bin-xyz', timeoutMs: 5_000 });
    await expect(
      runner.run({ userPrompt: 'hi', cwd: process.cwd() }),
    ).rejects.toThrow(/not found/);
  });
});
