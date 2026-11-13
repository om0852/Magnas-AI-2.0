import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { coveringWindows, parseWindows, RESTORE_WINDOWS, SHOW_DESKTOP } from '../src/hub/desktop.js';
import { Gateway } from '../src/hub/gateway.js';
import type { McpServer } from '../src/types.js';

const S: McpServer = { command: 'x', args: [], env: {} };
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content.map((c) => c.text).join(' '));

const LIST = [
  '5 window(s)',
  'w1 Claude "Claude" 0,0 1920x1040 maximized focused',
  'w2 chrome "YouTube - Google Chrome" 100,100 1200x800',
  'w3 cmd "Administrator: Command Prompt" 10,10 800x600 elevated',
  'w4 explorer "Downloads" 0,0 900x700 minimized',
  'w5 explorer "Program Manager" 0,0 1920x1080',
].join('\n');

/** A fake XtraOS: list_windows, window_bounds, and a drag that is covered until windows are minimised. */
async function fakeXtraos(calls: string[]): Promise<Client> {
  const minimized = new Set<string>();
  const server = new Server({ name: 'xtraos', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ['list_windows', 'window_bounds', 'drag'].map((name) => ({ name, inputSchema: { type: 'object' as const, properties: {} } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, string>;
    calls.push(`${req.params.name} ${JSON.stringify(a)}`);
    if (req.params.name === 'list_windows') return { content: [{ type: 'text', text: LIST }] };
    if (req.params.name === 'window_bounds') {
      if (a['state'] === 'minimize') minimized.add(a['window'] ?? '');
      if (a['state'] === 'restore') minimized.delete(a['window'] ?? '');
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    const covered = !minimized.has('w1') || !minimized.has('w2');
    return covered ? { content: [{ type: 'text', text: 'ERROR TARGET_OBSCURED: the point is covered' }], isError: true } : { content: [{ type: 'text', text: 'ok dragged' }] };
  });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await server.connect(x);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(y);
  return c;
}

test('desktop: window list parsed; only visible, non-admin windows cover the desktop', () => {
  const ws = parseWindows(LIST);
  assert.equal(ws.length, 5);
  assert.deepEqual(ws[0], { ref: 'w1', process: 'Claude', title: 'Claude', w: 1920, h: 1040, flags: ['maximized', 'focused'] });
  assert.deepEqual(coveringWindows(ws).map((w) => w.ref), ['w1', 'w2'], 'not the admin window, the minimised one or the desktop itself');
});

test('desktop: show and restore through XtraOS; a covered desktop drag clears the desktop and retries once', async () => {
  const calls: string[] = [];
  const g = new Gateway({ xtraos: S }, async () => fakeXtraos(calls));
  const names = (await g.listTools()).map((t) => t.name);
  assert.ok(names.includes(SHOW_DESKTOP) && names.includes(RESTORE_WINDOWS));

  const drag = await g.callTool('xtraos__drag', { window: 'desktop', from_ref: 'e1', to_x: 50, to_y: 300 });
  assert.notEqual(drag.isError, true, textOf(drag));
  assert.match(textOf(drag), /the desktop was covered\. Minimised 2 window\(s\)/);
  assert.match(textOf(drag), /ok dragged/);
  assert.deepEqual(calls.filter((c) => c.startsWith('window_bounds')), ['window_bounds {"window":"w1","state":"minimize"}', 'window_bounds {"window":"w2","state":"minimize"}']);

  assert.match(textOf(await g.callTool(RESTORE_WINDOWS, {})), /Restored 2 of 2/);
  assert.match(textOf(await g.callTool(RESTORE_WINDOWS, {})), /Nothing to restore/);

  // Left minimised by a brain that forgot: closing the hub restores them.
  await g.callTool(SHOW_DESKTOP, {});
  calls.length = 0;
  await g.close();
  assert.deepEqual(calls, ['window_bounds {"window":"w1","state":"restore"}', 'window_bounds {"window":"w2","state":"restore"}']);
});

test('desktop: no XtraOS behind the hub, no desktop tools', async () => {
  const g = new Gateway({}, async () => { throw new Error('none'); });
  assert.ok(!(await g.listTools()).some((t) => t.name === SHOW_DESKTOP));
  await g.close();
});

test('arrange: 43 scattered icons end up in columns at the left and right edges, nothing in the middle', async () => {
  const { arrangeIcons, parseDesktop } = await import('../src/hub/arrange.js');
  // A simulated Windows desktop: 1920x1040, grid 76x100 from (38,50), drops snap, taken cells refuse.
  const X0 = 38, Y0 = 50, DX = 76, DY = 100, COLS = 25, ROWS = 10;
  const snap = (x: number, y: number): [number, number] => [X0 + Math.round((x - X0) / DX) * DX, Y0 + Math.round((y - Y0) / DY) * DY];
  const icons = new Map<string, { name: string; x: number; y: number }>();
  for (let i = 0; i < 43; i++) {
    const [x, y] = snap(X0 + ((i * 7) % COLS) * DX, Y0 + ((i * 3) % ROWS) * DY);
    if ([...icons.values()].some((o) => o.x === x && o.y === y)) { const [x2, y2] = snap(X0 + ((i * 11 + 5) % COLS) * DX, Y0 + ((i + 4) % ROWS) * DY); icons.set(`e${100 + i}`, { name: `App ${i}`, x: x2, y: y2 }); }
    else icons.set(`e${100 + i}`, { name: `App ${i}`, x, y });
  }
  // make every position unique (the generator may still collide)
  const seen = new Set<string>();
  let k = 0;
  for (const ic of icons.values()) { while (seen.has(`${ic.x},${ic.y}`)) { [ic.x, ic.y] = snap(X0 + (k % COLS) * DX, Y0 + Math.floor(k / COLS) % ROWS * DY); k++; } seen.add(`${ic.x},${ic.y}`); }
  const observe = (): string => ['e1 List "Desktop" @960,520 (0,0 1920x1040)', ...[...icons].map(([ref, ic]) => `${ref} ListItem "${ic.name}" @${ic.x},${ic.y} (${ic.x - 37},${ic.y - 35} 75x70)`)].join('\n');
  let drags = 0;
  const call = async (name: string, a: Record<string, unknown>) => {
    if (name === 'xtraos__observe') return { content: [{ type: 'text' as const, text: observe() }] };
    if (name === 'xtraos__drag') {
      drags++;
      const ic = icons.get(String(a['from_ref']));
      if (!ic) return { content: [{ type: 'text' as const, text: 'ERROR STALE_REF' }], isError: true };
      const [x, y] = snap(Number(a['to_x']), Number(a['to_y']));
      if ([...icons.values()].some((o) => o !== ic && o.x === x && o.y === y)) return { content: [{ type: 'text' as const, text: 'ERROR TARGET_OCCUPIED: an icon is there' }], isError: true };
      ic.x = x; ic.y = y;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    }
    return { content: [{ type: 'text' as const, text: `unexpected ${name}` }], isError: true };
  };
  assert.equal(parseDesktop(observe()).icons.length, 43);
  const r = await arrangeIcons(call, 'left-right');
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /Done: all 43 icons are arranged, 22 in columns at the left edge and 21 at the right edge, none in the middle/);
  const cols = [...icons.values()].map((ic) => Math.round((ic.x - X0) / DX));
  assert.equal(cols.filter((c) => c <= 2).length, 22, 'left columns');
  assert.equal(cols.filter((c) => c >= COLS - 3).length, 21, 'right columns');
  assert.ok(drags <= 43, `${drags} drags: each icon moves at most once`);
  // Calling it again (as the brain did 5 times) moves nothing and says the task is done.
  const before = drags;
  const again = await arrangeIcons(call, 'left-right');
  assert.equal(drags, before, 'no shuffling on a second call');
  assert.match(textOf(again), /Already arranged: 22 icons on the left, 21 on the right.*do not call this again/);
});

test('arrange: icons already in a left or right column are never moved; only the middle ones go', async () => {
  const { colOf, gridOf, planRound, zonesOf } = await import('../src/hub/arrange.js');
  const area = { x: 0, y: 0, w: 1920, h: 1040 };
  const at = (ref: string, col: number, row: number) => ({ ref, name: ref, cx: 38 + col * 76, cy: 50 + row * 100, w: 75, h: 70 });
  // 4 on the left edge, 3 on the right edge, 3 in the middle: 10 icons, 5 per side.
  const icons = [at('L1', 0, 0), at('L2', 0, 1), at('L3', 0, 2), at('L4', 0, 3), at('R1', 24, 0), at('R2', 24, 1), at('R3', 24, 2), at('M1', 10, 4), at('M2', 12, 5), at('M3', 14, 6)];
  const g = gridOf(icons, area);
  assert.deepEqual([g.dx, g.dy, g.cols, g.rows], [76, 100, 25, 10]);
  const z = zonesOf(icons.length, g, 'left-right');
  const moves = planRound(icons, g, z);
  assert.deepEqual(moves.map((m) => m.ref).sort(), ['M1', 'M2', 'M3'], 'only the middle icons move');
  const toLeft = moves.filter((m) => colOf({ cx: m.x }, g) === 0).length;
  assert.equal(toLeft, 1, 'the left side needed one more');
  assert.equal(moves.length - toLeft, 2, 'the right side needed two more');
});
