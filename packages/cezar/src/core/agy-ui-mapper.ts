/**
 * Antigravity CLI (`agy`) `stream-json` -> protocol v2 mapper (+ v1 helpers).
 *
 * Emits normalized v2 `UiEvent`s alongside v1 `AgentEvent`s.
 * Never throws on malformed input. State is immutable.
 */

import type { AgentEvent } from './agent-runner.ts';
import type {
  StopReason,
  TokenUsage,
  UiEvent,
  UiMessageItem,
  UiSessionStartedEvent,
  UiToolItem,
  UiTurnCompletedEvent,
  UiUsageUpdatedEvent,
} from './ui-events.ts';
import { toolDisplay } from './tool-display.ts';

// ---- v2 state ---------------------------------------------------------------

export interface AgyUiMapperState {
  readonly fallbackSessionId?: string;
  readonly sessionId?: string;
  readonly sessionStarted: boolean;
  readonly turnSeq: number;
  readonly currentTurnId: string | null;
  readonly itemSeq: number;
  readonly sawAssistantText: boolean;
  readonly openTools: ReadonlyMap<string, UiToolItem>;
}

export interface AgyUiMapping {
  events: UiEvent[];
  state: AgyUiMapperState;
}

export function createAgyUiState(opts: { fallbackSessionId?: string } = {}): AgyUiMapperState {
  return {
    fallbackSessionId: opts.fallbackSessionId,
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    itemSeq: 0,
    sawAssistantText: false,
    openTools: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (isRecord(err)) {
    if (typeof err.message === 'string') return err.message;
    if (typeof err.error === 'string') return err.error;
    if (typeof err.errorMessage === 'string') return err.errorMessage;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Fold one parsed stream-json line into v2 events. Never throws. */
export function mapAgyMessage(msg: unknown, state: AgyUiMapperState): AgyUiMapping {
  try {
    if (!isRecord(msg)) return { events: [], state };
    const event = str(msg.event);

    switch (event) {
      case 'init':
        return mapInit(msg, state);
      case 'step_update':
        return mapStepUpdate(msg, state);
      case 'result':
        return mapResult(msg, state);
      default:
        return { events: [], state };
    }
  } catch {
    return { events: [], state };
  }
}

function mapInit(msg: Record<string, unknown>, state: AgyUiMapperState): AgyUiMapping {
  const sessionId = str(msg.conversation_id) ?? state.fallbackSessionId ?? '';
  const initObj = isRecord(msg.init) ? msg.init : {};
  const event: UiSessionStartedEvent = {
    type: 'session.started',
    sessionId,
    backend: 'agy',
  };
  const model = str(initObj.model);
  if (model !== undefined) event.model = model;
  const cwd = str(initObj.cwd);
  if (cwd !== undefined) event.cwd = cwd;

  const turnId = `turn_${state.turnSeq + 1}`;
  return {
    events: [event, { type: 'turn.started', turnId }],
    state: {
      ...state,
      sessionId,
      sessionStarted: true,
      turnSeq: state.turnSeq + 1,
      currentTurnId: turnId,
    },
  };
}

function mapStepUpdate(msg: Record<string, unknown>, state: AgyUiMapperState): AgyUiMapping {
  if (!isRecord(msg.step_update)) return { events: [], state };
  const update = msg.step_update;
  const stepType = str(update.step_type);

  if (stepType === 'agent_response') {
    return mapAgentResponse(update, state);
  }

  if (stepType === 'tool') {
    return mapToolUpdate(update, state);
  }

  return { events: [], state };
}

function mapAgentResponse(update: Record<string, unknown>, state: AgyUiMapperState): AgyUiMapping {
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let sawAssistantText = state.sawAssistantText;
  const textDelta = typeof update.text_delta === 'string' ? update.text_delta : '';

  if (textDelta) {
    if (!sawAssistantText) {
      sawAssistantText = true;
      const startItem: UiMessageItem = {
        kind: 'message',
        id: `item_${++itemSeq}`,
        role: 'assistant',
        text: '',
      };
      events.push({ type: 'item.started', item: startItem });
    }
    const currentItemId = `item_${itemSeq}`;
    events.push({
      type: 'item.delta',
      itemId: currentItemId,
      field: 'text',
      delta: textDelta,
    });
  }

  if (str(update.state) === 'DONE' && sawAssistantText) {
    const completedItem: UiMessageItem = {
      kind: 'message',
      id: `item_${itemSeq}`,
      role: 'assistant',
      text: textDelta, // The full text will be rendered from deltas
    };
    events.push({ type: 'item.completed', item: completedItem });
  }

  const usage = parseUsage(update.usage);
  if (usage) {
    events.push({
      type: 'usage.updated',
      usage,
    });
  }

  return {
    events,
    state: {
      ...state,
      itemSeq,
      sawAssistantText,
    },
  };
}

function mapToolUpdate(update: Record<string, unknown>, state: AgyUiMapperState): AgyUiMapping {
  const toolName = str(update.tool_name) ?? 'tool';
  const toolInfo = isRecord(update.tool_info) ? update.tool_info : {};
  const toolStatus = str(update.state) ?? 'ACTIVE';
  const stepIndex = num(update.step_index) ?? state.itemSeq + 1;
  const callId = `call_${stepIndex}`;

  if (toolStatus === 'ACTIVE') {
    const params = isRecord(toolInfo.parameters) ? toolInfo.parameters : undefined;
    const display = toolDisplay(toolName, params);
    const item: UiToolItem = {
      kind: 'tool',
      id: callId,
      name: toolName,
      toolKind: display.toolKind,
      title: display.title,
      status: 'running',
    };
    if (params) item.input = params;

    const openTools = new Map(state.openTools);
    openTools.set(callId, item);
    return {
      events: [{ type: 'item.started', item }],
      state: { ...state, openTools },
    };
  }

  if (toolStatus === 'DONE' || toolStatus === 'ERROR') {
    const open = state.openTools.get(callId);
    const params = isRecord(toolInfo.parameters) ? toolInfo.parameters : undefined;
    const display = toolDisplay(toolName, params);
    const isError = toolStatus === 'ERROR' || toolInfo.error !== undefined;

    const item: UiToolItem = {
      ...(open ?? {
        kind: 'tool',
        id: callId,
        name: toolName,
        toolKind: display.toolKind,
        title: display.title,
      }),
      status: isError ? 'failed' : 'completed',
    };
    if (params && !item.input) item.input = params;

    if (toolInfo.result !== undefined) {
      item.output = typeof toolInfo.result === 'string' ? toolInfo.result : JSON.stringify(toolInfo.result);
    }
    if (toolInfo.error !== undefined) {
      item.error = extractErrorMessage(toolInfo.error);
    }

    const openTools = new Map(state.openTools);
    openTools.delete(callId);
    return {
      events: [{ type: 'item.completed', item }],
      state: { ...state, openTools },
    };
  }

  return { events: [], state };
}

function mapResult(msg: Record<string, unknown>, state: AgyUiMapperState): AgyUiMapping {
  const res = isRecord(msg.result) ? msg.result : msg;
  const events: UiEvent[] = [];
  let itemSeq = state.itemSeq;
  let sawAssistantText = state.sawAssistantText;

  // Close any orphan open tools as failed
  for (const open of state.openTools.values()) {
    events.push({ type: 'item.completed', item: { ...open, status: 'failed' } });
  }

  const responseText = str(res.response);
  if (!sawAssistantText && responseText) {
    sawAssistantText = true;
    const item: UiMessageItem = {
      kind: 'message',
      id: `item_${++itemSeq}`,
      role: 'assistant',
      text: responseText,
    };
    events.push({ type: 'item.started', item }, { type: 'item.completed', item });
  }

  const turnId = state.currentTurnId ?? `turn_${Math.max(1, state.turnSeq)}`;
  const statusStr = str(res.status);
  const stopReason: StopReason = statusStr === 'ERROR' ? 'error' : 'end_turn';

  const turnEvent: UiTurnCompletedEvent = {
    type: 'turn.completed',
    turnId,
    stopReason,
  };
  const usage = parseUsage(res.usage);
  if (usage) turnEvent.usage = usage;
  events.push(turnEvent);

  if (usage) {
    events.push({ type: 'usage.updated', usage });
  }

  return {
    events,
    state: {
      ...state,
      itemSeq,
      sawAssistantText,
      currentTurnId: null,
      openTools: new Map(),
    },
  };
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = num(raw.input_tokens) ?? 0;
  const output = num(raw.output_tokens) ?? 0;
  const reasoning = num(raw.thinking_tokens);
  const cacheRead = num(raw.cache_read_tokens);
  const total = num(raw.total_tokens) ?? input + output;
  if (total <= 0) return undefined;
  const usage: TokenUsage = { input, output, total };
  if (reasoning !== undefined && reasoning > 0) usage.reasoning = reasoning;
  if (cacheRead !== undefined && cacheRead > 0) usage.cacheRead = cacheRead;
  return usage;
}

// ---- v1 stream events -------------------------------------------------------

export function mapAgyStreamEvent(raw: unknown): AgentEvent[] {
  if (!isRecord(raw)) return [];
  const event = str(raw.event);

  try {
    if (event === 'init') {
      const sessionId = str(raw.conversation_id);
      return sessionId ? [{ type: 'session', sessionId }] : [];
    }

    if (event === 'step_update' && isRecord(raw.step_update)) {
      const update = raw.step_update;
      const stepType = str(update.step_type);

      if (stepType === 'agent_response') {
        const events: AgentEvent[] = [];
        const textDelta = typeof update.text_delta === 'string' ? update.text_delta : '';
        if (textDelta) {
          events.push({ type: 'text', text: textDelta });
        }
        const usage = parseUsage(update.usage);
        if (usage) {
          events.push({ type: 'token-usage', tokensUsed: usage.total });
        }
        return events;
      }

      if (stepType === 'tool') {
        const stepIndex = num(update.step_index) ?? 0;
        const callId = `call_${stepIndex}`;
        const toolName = str(update.tool_name) ?? 'tool';
        const toolInfo = isRecord(update.tool_info) ? update.tool_info : {};
        const stateStr = str(update.state);

        if (stateStr === 'ACTIVE') {
          const input = isRecord(toolInfo.parameters) ? toolInfo.parameters : {};
          return [{ type: 'tool-call', id: callId, tool: toolName, input }];
        }

        if (stateStr === 'DONE' || stateStr === 'ERROR') {
          const isError = stateStr === 'ERROR' || toolInfo.error !== undefined;
          const resultStr =
            toolInfo.result !== undefined
              ? typeof toolInfo.result === 'string'
                ? toolInfo.result
                : JSON.stringify(toolInfo.result)
              : toolInfo.error !== undefined
                ? extractErrorMessage(toolInfo.error)
                : '';
          return [{ type: 'tool-result', toolCallId: callId, result: resultStr, isError }];
        }
      }

      return [];
    }

    if (event === 'result') {
      const res = isRecord(raw.result) ? raw.result : raw;
      const events: AgentEvent[] = [];
      const usage = parseUsage(res.usage);
      if (usage) {
        events.push({ type: 'token-usage', tokensUsed: usage.total });
      }
      if (str(res.status) === 'ERROR') {
        const msg = str(res.error) ?? str(res.error_message) ?? 'Antigravity agent reported an error';
        events.push({ type: 'error', message: msg });
      }
      events.push({ type: 'turn-end' });
      return events;
    }

    return [];
  } catch {
    return [];
  }
}
