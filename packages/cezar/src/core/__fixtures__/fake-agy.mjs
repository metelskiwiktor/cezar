// Stand-in for the `agy` CLI in agy-hardening tests. Behavior is chosen by FAKE_AGY_MODE;
// it ignores agy's own argv. Never talks to the network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';
let stdinPrompt = '';
for await (const chunk of process.stdin) stdinPrompt += chunk;
const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// Live run 2bb661b9: the final review text, then agy's own result error.
const MALFORMED = 'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.\nPlease retry with a properly formatted function call\nRetries remaining: 3';
const resultError = () => {
  const error = process.env.FAKE_AGY_RESULT_ERROR === 'malformed' ? MALFORMED : process.env.FAKE_AGY_RESULT_ERROR;
  if (!error) return;
  line({ event: 'result', result: { status: 'ERROR', error } });
  if (process.env.FAKE_AGY_AFTER_ERROR) line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Retrying.' } });
};
const trustedDiffReads = (tool) => {
  const prompt = stdinPrompt;
  const file = prompt.match(/Cezar pinned diff file: (.+)\n/)?.[1];
  const count = Number(prompt.match(/Diff lines: (\d+)/)?.[1]);
  const parts = [...prompt.matchAll(/Part \d+: (.+) \((\d+) lines\)/g)];
  if (file && process.env.FAKE_AGY_OMIT !== 'trusted-diff') {
    if (process.env.FAKE_AGY_DIFF_VIEW_MODE === 'no-range') {
      tool('view_file', { AbsolutePath: file });
    } else if (process.env.FAKE_AGY_DIFF_VIEW_MODE === 'parts-only') {
      for (const p of parts) tool('view_file', { AbsolutePath: p[1] });
    } else if (process.env.FAKE_AGY_DIFF_VIEW_MODE === 'partial-parts') {
      if (parts[0]) tool('view_file', { AbsolutePath: parts[0][1] });
    } else {
      for (let StartLine = 1; StartLine <= count; StartLine += 500) {
        tool('view_file', { AbsolutePath: file, StartLine, EndLine: Math.min(StartLine + 499, count) });
      }
      for (const p of parts) tool('view_file', { AbsolutePath: p[1] });
    }
  }
  if (process.env.FAKE_AGY_OMIT !== 'check-result') {
    for (const match of prompt.matchAll(/Cezar check result file: (.+)\nResult lines: (\d+)/g)) {
      const checkFile = match[1];
      const checkCount = Number(match[2]);
      if (process.env.FAKE_AGY_CHECK_VIEW_MODE === 'no-range') {
        tool('view_file', { AbsolutePath: checkFile });
      } else {
        for (let StartLine = 1; StartLine <= checkCount; StartLine += 500) {
          tool('view_file', { AbsolutePath: checkFile, StartLine, EndLine: Math.min(StartLine + 499, checkCount) });
        }
      }
    }
  }
  return file;
};

if (process.env.FAKE_AGY_ASSERT_PR_SCOPE) {
  const args = process.argv.slice(2);
  if (!args.includes('--disable-slash-commands') || args.includes('--sandbox') || args.includes('--dangerously-skip-permissions') ||
      args[args.indexOf('--mode') + 1] !== 'accept-edits' || args.filter((v) => v === '--add-dir').length !== 1 ||
      stdinPrompt.includes('MAIN_IMPLEMENTATION_SKILL') || args.join(' ').length > 28000 ||
      ['CEZ_HANDOFF_FILE', 'CEZ_TODOS_FILE', 'CEZ_TREE_DIR', 'CEZ_BIN', 'GH_TOKEN', 'EXPO_TOKEN', 'EAS_TOKEN', 'EAS_ACCESS_TOKEN'].some((key) => process.env[key])) {
    process.stderr.write('PR review leaked implementation context or external roots');
    process.exit(1);
  }
}

switch (mode) {
  case 'recovery': {
    let id = 0;
    const tool = (tool_name, parameters, error) => {
      if (tool_name === 'view_file' && process.env.FAKE_AGY_READ_FILE) {
        tool_name = 'read_file';
        const { AbsolutePath, ...range } = parameters;
        parameters = { ...range, Path: AbsolutePath };
      }
      const step_index = ++id;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: error ? 'ERROR' : 'DONE', step_type: 'tool', tool_name, tool_info: error ? { error } : { result: '' } } });
    };
    const read = (path, error) => tool('view_file', { AbsolutePath: join(process.cwd(), path) }, error);
    const suppliedDiff = trustedDiffReads(tool);
    if (!process.env.FAKE_AGY_SKIP_ERROR) read(process.env.FAKE_AGY_MISSING_PATH ?? 'src/models/index.ts', process.env.FAKE_AGY_ERROR ?? 'GetFileAttributesEx: The system cannot find the path specified.');
    for (let n = 0; n < Number(process.env.FAKE_AGY_EXTRA_MISSES ?? 0); n++) read(`docs/optional${n}/README.md`, 'ENOENT: no such file or directory');
    if (process.env.FAKE_AGY_OMIT !== 'correction') read('src/models.ts');
    for (let n = 0; n < Number(process.env.FAKE_AGY_EXTRA_READS ?? 0); n++) read('src/models.ts');
    if (process.env.FAKE_AGY_OMIT !== 'agents') read('AGENTS.md');
    if (process.env.FAKE_AGY_OMIT !== 'changed') read('tracked.txt');
    if (process.env.FAKE_AGY_OMIT !== 'diff' && !suppliedDiff) tool('run_command', { CommandLine: process.env.FAKE_AGY_DIFF });
    if (process.env.FAKE_AGY_MUTATE) tool('write_to_file', { TargetFile: 'tracked.txt' });
    if (process.env.FAKE_AGY_PENDING) line({ event: 'step_update', step_update: { step_index: ++id, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), 'tracked.txt') } } } });
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: process.env.FAKE_AGY_FINAL_TEXT ?? 'Findings: none. Reviewed AGENTS.md, the full diff and changed files; no correctness or regression issues found.\nRecommendation: APPROVE' } });
    resultError();
    break;
  }
  // Live run 5a3f5ec0: absolute diff reads, then a RELATIVE read_file that agy's own permission
  // step rejects before the tool runs ("path is not absolute"); agy then goes on talking.
  case 'relative-read': {
    const prompt = stdinPrompt;
    const args = process.argv.slice(2);
    const served = prompt.match(/Cezar served read file: (.+)\n/)?.[1];
    if (served && args[args.indexOf('--conversation') + 1] !== 'review-fixture-local') process.exit(5);
    if (process.env.FAKE_AGY_REL_TRACE && served === undefined) writeFileSync(process.env.FAKE_AGY_REL_TRACE, 'turn1');
    line({ event: 'init', conversation_id: 'review-fixture-local' });
    let step = 10;
    const tool = (tool_name, parameters, error) => {
      const step_index = ++step;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: error ? 'ERROR' : 'DONE', step_type: 'tool', tool_name, tool_info: error ? { error } : { result: '' } } });
    };
    trustedDiffReads(tool);
    tool('view_file', { AbsolutePath: join(process.cwd(), 'AGENTS.md') });
    if (served) {
      if (!process.env.FAKE_AGY_OMIT_SERVED_READ) tool(process.env.FAKE_AGY_REL_TOOL ?? 'read_file', process.env.FAKE_AGY_REL_TOOL === 'view_file' ? { AbsolutePath: served } : { Path: served });
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Findings: none. Read the changed file via the served copy.\nRecommendation: APPROVE' } });
      break;
    }
    const rel = process.env.FAKE_AGY_REL_PATH ?? 'tracked.txt';
    const useView = process.env.FAKE_AGY_REL_TOOL === 'view_file';
    const params = { ...(useView ? { AbsolutePath: rel } : { Path: rel }), StartLine: 1, EndLine: 5 };
    const name = useView ? 'view_file' : 'read_file';
    line({ event: 'step_update', step_update: { step_index: 50, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { parameters: params } } });
    line({ event: 'step_update', step_update: { step_index: 50, state: 'ERROR', step_type: 'tool', tool_name: name, tool_info: { error: `declaring permissions: failed to parse path: ${rel} must be an absolute path: path is not absolute` } } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // A runner that did not stop the turn would let this unverified verdict through.
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Findings: none.\nRecommendation: APPROVE' } });
    break;
  }
  case 'denial':
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), '..', 'denied.md') } } } });
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'view_file', tool_info: { error: 'permission check failed for read_file: user denied permission' } } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    line({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'attempt to bypass denial' } } } });
    break;
  case 'windows-exebox': {
    const diff = 'git diff --stat 03981fdebb98e7f9d40a73045487a61be13afdbe 4eeba07835719eedbea33e59155216451c179c72';
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: diff } } } });
    line({ event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: 'exebox: sandboxing on Windows requires Windows 11 24H2 or later with the August 2026 or later update: process security environments are not supported: The specified module could not be found' } } });
    line({ event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: `permission check failed for unsandboxed ${diff}: user denied permission` } } });
    break;
  }
  case 'native-recovery': {
    const prompt = stdinPrompt;
    line({ event: 'init', conversation_id: 'review-fixture-local' });
    let step = 0;
    const tool = (tool_name, parameters) => {
      const step_index = ++step;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: 'DONE', step_type: 'tool', tool_name, tool_info: { result: '' } } });
    };
    trustedDiffReads(tool);
    if (!prompt.includes('The previous native terminal attempt was stopped') || process.env.FAKE_AGY_REPEAT_NATIVE) {
      if (process.env.FAKE_AGY_NATIVE_MUTATE_PATH) writeFileSync(process.env.FAKE_AGY_NATIVE_MUTATE_PATH, 'changed before event');
      line({ event: 'step_update', step_update: { step_index: ++step, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: process.env.FAKE_AGY_NATIVE_COMMAND ?? 'Select-String -Path vite.config.ts -Pattern test' } } } });
      if (process.env.FAKE_AGY_NATIVE_DENIAL) line({ event: 'step_update', step_update: { step_index: step, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: 'user denied permission' } } });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      break;
    }
    tool('view_file', { AbsolutePath: join(process.cwd(), 'AGENTS.md') });
    if (!process.env.FAKE_AGY_OMIT_CHANGED) tool('read_file', { Path: join(process.cwd(), 'tracked.txt') });
    const response = prompt.includes('Cezar check result file:') ? 'Findings: none.\nRecommendation: APPROVE' : 'CEZ_REVIEW_CHECK {"args":["git","grep","v2","tracked.txt"],"reason":"inspect change"}';
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: response } });
    break;
  }
  case 'vite-search': {
    const prompt = stdinPrompt;
    if (!prompt.includes('case-insensitive search such as include or test') || !prompt.includes('search result does not count as opening a changed file')) process.exit(10);
    const args = process.argv.slice(2);
    const resultFile = prompt.match(/Cezar check result file: (.+)\n/)?.[1];
    if (resultFile && args[args.indexOf('--conversation') + 1] !== 'review-fixture-local') process.exit(5);
    line({ event: 'init', conversation_id: 'review-fixture-local' });
    let step = 0;
    const tool = (tool_name, parameters) => {
      const step_index = ++step;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: 'DONE', step_type: 'tool', tool_name, tool_info: { result: '' } } });
    };
    trustedDiffReads(tool);
    tool('read_file', { Path: join(process.cwd(), 'AGENTS.md') });
    if (!resultFile) {
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'CEZ_REVIEW_CHECK {"args":["git","grep","-i","-E","include|test","vite.config.ts"],"reason":"inspect configuration"}' } });
    } else {
      const { readFileSync } = await import('node:fs');
      if (!readFileSync(resultFile, 'utf8').includes('vite.config.ts:1:')) process.exit(9);
      if (!process.env.FAKE_AGY_OMIT_CHANGED) tool('read_file', { Path: join(process.cwd(), 'vite.config.ts') });
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Findings: none.\nRecommendation: APPROVE' } });
    }
    break;
  }
  case 'broker': {
    const prompt = stdinPrompt;
    const args = process.argv.slice(2);
    if (args.includes('--conversation') && args[args.indexOf('--conversation') + 1] !== 'review-fixture-local') process.exit(5);
    if (prompt.includes('Cezar trusted check result:') && !args.includes('--conversation')) process.exit(6);
    // `|`-separated fragments the prompt must (not) contain: the generated check policy.
    if (process.env.FAKE_AGY_PROMPT_HAS?.split('|').some((s) => !prompt.includes(s))) { process.stderr.write('prompt lacks expected text'); process.exit(7); }
    if (process.env.FAKE_AGY_PROMPT_LACKS?.split('|').some((s) => prompt.includes(s))) { process.stderr.write('prompt has unexpected text'); process.exit(8); }
    line({ event: 'init', conversation_id: 'review-fixture-local' });
    let step = 10;
    const file = trustedDiffReads((tool_name, parameters) => {
      const step_index = ++step;
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name, tool_info: { parameters } } });
      line({ event: 'step_update', step_update: { step_index, state: 'DONE', step_type: 'tool', tool_name, tool_info: { result: '' } } });
    });
    const { readFileSync } = await import('node:fs');
    if (!file || !readFileSync(file, 'utf8').includes('+v2')) process.exit(4);
    for (const [step_index, name] of [[1, 'AGENTS.md'], [2, 'tracked.txt']]) {
      line({ event: 'step_update', step_update: { step_index, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), name) } } } });
      line({ event: 'step_update', step_update: { step_index, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { result: '' } } });
    }
    // FAKE_AGY_CHECKS: one request per turn, in order (e.g. a rejected one, then its correction).
    const checks = process.env.FAKE_AGY_CHECKS ? JSON.parse(process.env.FAKE_AGY_CHECKS) : [JSON.parse(process.env.FAKE_AGY_CHECK)];
    const answered = (prompt.match(/Cezar check result file:/g) ?? []).length;
    const final = answered >= checks.length && !process.env.FAKE_AGY_REPEAT;
    const response = final
      ? (process.env.FAKE_AGY_VERDICT ?? `Findings: none. Full pinned diff and contracts inspected. Verification: ${checks.at(-1).join(' ')} returned exit 0. Emulator skipped: no resource authorization.\nRecommendation: APPROVE`)
      : `CEZ_REVIEW_CHECK ${JSON.stringify({ args: checks[Math.min(answered, checks.length - 1)], reason: 'inspect affected contract' })}`;
    if (!final && process.env.FAKE_AGY_MIDTURN) {
      // Live run 2bb661b9: the request is one message mid-turn, as deltas; Gemini keeps
      // inspecting and concludes without the result unless Cezar stops the turn.
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Planning verification.\n' } });
      line({ event: 'step_update', step_update: { step_index: 90, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { parameters: { DirectoryPath: process.cwd() } } } });
      line({ event: 'step_update', step_update: { step_index: 90, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', tool_info: { result: '' } } });
      for (const text_delta of [response.slice(0, 9), response.slice(9), '\n']) line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      line({ event: 'step_update', step_update: { step_index: 91, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: join(process.cwd(), 'tracked.txt') } } } });
      line({ event: 'step_update', step_update: { step_index: 91, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { result: '' } } });
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'UNCHECKED: Executed checks: None.\nRecommendation: APPROVE' } });
      resultError();
      break;
    }
    line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: response } });
    if (final) resultError();
    break;
  }
  case 'write':
    writeFileSync(join(process.cwd(), 'written-by-agent.txt'), 'ok\n');
    break;
  case 'hang':
    setInterval(() => {}, 1_000);
    break;
  case 'deltas':
    // One message streamed as deltas, the way agy streams `agent_response` text.
    for (const text_delta of ['Find', 'ings: no', 'ne.\n', 'Recommendation: ', 'APPROVE']) {
      line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } });
    }
    break;
  case 'fail':
    process.stderr.write('boom\n');
    process.exit(3);
    break;
  default:
    break;
}
if (mode !== 'hang') line({ type: 'noop' });
