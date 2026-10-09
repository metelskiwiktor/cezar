import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.ts';
import { AgyCliRunner } from './agy-cli-runner.ts';
import { createRunner } from './runner-factory.ts';
import type { UiEvent } from './ui-events.ts';
import { resolveAgyBin } from './agy-bin.ts';

// Opt-in only: an installed agy alone must not make a routine test run spend real model calls.
const isAgyAvailable = process.env.AGY_REAL_SMOKE === '1' && resolveAgyBin() !== 'agy';

describe.skipIf(!isAgyAvailable)('AgyCliRunner against real agy CLI on Windows (opt-in smoke)', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cez-agy-smoke-'));
    writeFileSync(join(cwd, 'input.txt'), 'Wartosc poczatkowa: 42\n');
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('Turn 1: executes multi-step tool-calling with accept-edits in isolated cwd', async () => {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];

    const runner = createRunner('agy');
    expect(runner).toBeInstanceOf(AgyCliRunner);

    const session = runner.startSession(
      {
        userPrompt: 'Przeczytaj plik input.txt, dodaj 8 do liczby (wynik to 50), zapisz liczbe 50 do pliku output.txt w biezacym katalogu i napisz GOTOWE.',
        cwd,
        timeoutMs: 60_000,
      },
      (e) => events.push(e),
      {
        autoEndAfterFirstTurn: false,
        onUiEvent: (e) => ui.push(e),
      },
    );

    // Wait for the first turn to complete and produce results
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    // Verify output.txt was written by agy via tools
    const outputPath = join(cwd, 'output.txt');
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toContain('50');

    // Verify v1 events
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('session');
    expect(eventTypes).toContain('tool-call');
    expect(eventTypes).toContain('tool-result');

    // Verify v2 events
    const uiTypes = ui.map((e) => e.type);
    expect(uiTypes).toContain('session.started');
    expect(uiTypes).toContain('turn.started');

    // End session
    session.end();
  }, 90_000);
});
