import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, DEFAULT_BRAIN } from '../src/brain/ask.js';
import { parseAgyLine, parseCodexLine, type Progress } from '../src/brain/progress.js';
import type { BrainRunner } from '../src/brain/runners.js';

// Lines as Codex CLI 0.163 and Antigravity CLI 1.5 printed them on the owner's PC (2026-11-12).
const CODEX = [
  '{"type":"thread.started","thread_id":"01a1cfbc"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"magnus","tool":"xtraos__list_windows","arguments":{},"result":null,"error":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"magnus","tool":"xtraos__list_windows","arguments":{},"result":{"content":[{"type":"text","text":"8 window(s)\\nw1 firefox.exe \\"x\\""}]},"error":null,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"8"}}',
  '{"type":"turn.completed","usage":{"input_tokens":90645}}',
];
const AGY = [
  '{"event":"init","conversation_id":"ec22","init":{"cwd":"C:\\\\x","tools":["ask_permission"]}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{},"ServerName":"xtraos","ToolName":"list_windows"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{},"ServerName":"xtraos","ToolName":"list_windows"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"8"}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
  '{"event":"result","result":{"status":"SUCCESS","response":"8\\n"}}',
];

test('progress: Codex lines become steps, a tool call count and the answer', () => {
  const p = CODEX.map(parseCodexLine);
  assert.deepEqual(p[0], {});
  assert.deepEqual(p[2], { step: { kind: 'tool', text: 'xtraos__list_windows' }, toolCall: 'xtraos__list_windows' });
  assert.deepEqual(p[3], { step: { kind: 'tool-done', text: 'xtraos__list_windows → 8 window(s)' } });
  assert.deepEqual(p[4], { step: { kind: 'say', text: '8' }, answer: '8' });
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"mcp_tool_call","tool":"xtraos__click","error":"BLOCKED_BY_POLICY: denied"}}').step, { kind: 'tool-failed', text: 'xtraos__click: BLOCKED_BY_POLICY: denied' });
  assert.equal(parseCodexLine('{"type":"item.started","item":{"type":"mcp_tool_call","tool":"t","arguments":{"text":"' + 'x'.repeat(300) + '"}}}').step?.text.length, 82, 'long arguments are cut');
  assert.deepEqual(parseCodexLine('not json'), {});
});

test('progress: Antigravity lines become steps, tool calls and the answer', () => {
  const p = AGY.map(parseAgyLine);
  assert.deepEqual([p[0], p[1]], [{}, {}]);
  assert.deepEqual(p[2], { step: { kind: 'tool', text: 'xtraos/list_windows' }, toolCall: 'xtraos/list_windows' });
  assert.deepEqual(p[3], { step: { kind: 'tool-done', text: 'xtraos/list_windows' } });
  assert.deepEqual(p[4], { textDelta: '8', responseDone: false });
  assert.deepEqual(p[5], { textDelta: '\n', responseDone: true });
  assert.deepEqual(p[6], { answer: '8' });
});

test('stop: a stopped run is reported as stopped and never handed to the other brain', async () => {
  const seen: string[] = [];
  const steps: Progress[] = [];
  const codex: BrainRunner = (_p, _t, opts) =>
    new Promise((resolve) => {
      opts?.onProgress?.({ kind: 'tool', text: 'xtraos__list_windows', ms: 5 });
      seen.push('codex');
      opts?.signal?.addEventListener('abort', () => resolve({ ok: false, answer: 'Stopped by you.', toolCalls: [], callsKnown: true, timedOut: false, stopped: true, ms: 9 }));
    });
  const agy: BrainRunner = async () => {
    seen.push('agy');
    return { ok: true, answer: 'x', toolCalls: [], callsKnown: true, timedOut: false, ms: 1 };
  };
  const ctl = new AbortController();
  const running = ask('open YouTube', DEFAULT_BRAIN, { codex, antigravity: agy }, { signal: ctl.signal, onProgress: (p) => steps.push(p) });
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  const r = await running;
  assert.deepEqual([r.ok, r.answer, r.stoppedBecause, seen], [false, 'Stopped by you.', 'you pressed Stop', ['codex']]);
  assert.deepEqual(steps.map((s) => s.kind), ['tool']);
});
