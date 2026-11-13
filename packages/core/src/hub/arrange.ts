/**
 * Arranging desktop icons in code (ADR 0018): the brain calls one tool, Magnus does the repetitive
 * part (dozens of drags) deterministically. Pure planning functions plus a runner that uses
 * XtraOS's observe and drag through the hub, so every move still passes XtraOS's policy and log.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const ARRANGE_ICONS = 'magnus__arrange_desktop_icons';

export interface Icon {
  ref: string;
  name: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Layout = 'left-right' | 'left' | 'right';

/** Desktop icons and the desktop area from `observe {window:"desktop", full, bounds}` text (pure). */
export function parseDesktop(text: string): { icons: Icon[]; area: Area | null } {
  const icons: Icon[] = [];
  let area: Area | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^(e\d+) (\w+) "(.*)".* @(-?\d+),(-?\d+) \((-?\d+),(-?\d+) (\d+)x(\d+)\)\s*$/.exec(line);
    if (!m) continue;
    const [ref, role, name, cx, cy, x, y, w, h] = [m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9]].map(String) as [string, string, string, string, string, string, string, string, string];
    if (role === 'ListItem') icons.push({ ref, name, cx: Number(cx), cy: Number(cy), w: Number(w), h: Number(h) });
    else if (role === 'List' || role === 'Pane' || role === 'Window') {
      const a = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
      if (area === null || a.w * a.h > area.w * area.h) area = a;
    }
  }
  return { icons, area };
}

/**
 * The grid step along one axis (pure): the smallest gap between icon centres that is at least about
 * an icon wide and of which the other gaps are whole multiples (sparse columns give gaps of 2 or 10
 * steps; the most common gap would then be wrong).
 */
function step(values: number[], minGap: number, fallback: number): number {
  const v = [...new Set(values.map((x) => Math.round(x)))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < v.length; i++) {
    const g = (v[i] as number) - (v[i - 1] as number);
    if (g >= minGap * 0.9) gaps.push(g);
  }
  for (const c of [...new Set(gaps)].sort((a, b) => a - b)) {
    if (c > 400) break;
    const fits = gaps.filter((g) => Math.abs(g / c - Math.round(g / c)) < 0.12).length;
    // Cells are barely bigger than an icon: a gap of about two icons is two cells.
    if (fits >= gaps.length * 0.8) return c / Math.max(1, Math.floor(c / (minGap * 0.98)));
  }
  return fallback;
}

export interface Grid {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  cols: number;
  rows: number;
}

/** The desktop grid: spacing from where the icons sit now, aligned to the area's edges (pure). */
export function gridOf(icons: readonly Icon[], area: Area): Grid {
  const w = icons.length > 0 ? Math.max(...icons.map((i) => i.w)) : 76;
  const h = icons.length > 0 ? Math.max(...icons.map((i) => i.h)) : 76;
  const dx = step(icons.map((i) => i.cx), w, w + 4);
  const dy = step(icons.map((i) => i.cy), h, h + 4);
  // Align the first cell with the grid the icons already use, as close to the top-left as fits.
  const ref = icons[0] ?? { cx: area.x + dx / 2, cy: area.y + dy / 2 };
  let x0 = ref.cx;
  while (x0 - dx >= area.x + dx * 0.3) x0 -= dx;
  while (x0 < area.x + dx * 0.3) x0 += dx;
  let y0 = ref.cy;
  while (y0 - dy >= area.y + dy * 0.3) y0 -= dy;
  while (y0 < area.y + dy * 0.3) y0 += dy;
  const cols = Math.max(1, Math.floor((area.x + area.w - x0 + dx * 0.5) / dx));
  const rows = Math.max(1, Math.floor((area.y + area.h - y0 + dy * 0.5) / dy));
  return { x0, y0, dx, dy, cols, rows };
}

export interface Move {
  ref: string;
  name: string;
  x: number;
  y: number;
}

export interface Zones {
  /** How many icons belong on each side. */
  nLeft: number;
  nRight: number;
  /** Columns of each zone, from the edge inwards. */
  leftCols: number[];
  rightCols: number[];
}

/** Which grid column an icon is in (pure). */
export const colOf = (i: { cx: number }, g: Grid): number => Math.round((i.cx - g.x0) / g.dx);
const rowOf = (i: { cy: number }, g: Grid): number => Math.round((i.cy - g.y0) / g.dy);

/** The left and right zones: just enough columns at each edge for its share of the icons (pure). */
export function zonesOf(n: number, g: Grid, layout: Layout): Zones {
  const nLeft = layout === 'left' ? n : layout === 'right' ? 0 : Math.ceil(n / 2);
  const nRight = n - nLeft;
  const lc = Math.ceil(nLeft / g.rows);
  const rc = Math.ceil(nRight / g.rows);
  return {
    nLeft,
    nRight,
    leftCols: [...Array(lc).keys()],
    rightCols: [...Array(rc).keys()].map((k) => g.cols - 1 - k),
  };
}

/**
 * One round's moves (pure). Icons already in their zone stay where they are (no shuffling): only
 * icons outside both zones, and the extras of a zone with too many, move, each into the free cell
 * of its side nearest the edge and the top.
 */
export function planRound(icons: readonly Icon[], g: Grid, z: Zones): Move[] {
  const inL = icons.filter((i) => z.leftCols.includes(colOf(i, g)));
  const inR = icons.filter((i) => z.rightCols.includes(colOf(i, g)));
  const out = icons.filter((i) => !inL.includes(i) && !inR.includes(i));
  // Extras: the innermost icons of a zone with too many.
  const byInner = (side: 'L' | 'R') => (a: Icon, b: Icon) => (side === 'L' ? colOf(b, g) - colOf(a, g) : colOf(a, g) - colOf(b, g)) || b.cy - a.cy;
  const extraL = [...inL].sort(byInner('L')).slice(0, Math.max(0, inL.length - z.nLeft));
  const extraR = [...inR].sort(byInner('R')).slice(0, Math.max(0, inR.length - z.nRight));
  let needL = z.nLeft - (inL.length - extraL.length);
  const movers: { ic: Icon; side: 'L' | 'R' }[] = [];
  // Middle icons nearest the left go left first, so moves are short.
  for (const ic of [...out, ...extraR, ...extraL].sort((a, b) => a.cx - b.cx || a.cy - b.cy)) {
    const fromLeftZone = extraL.includes(ic);
    const side: 'L' | 'R' = needL > 0 && !fromLeftZone ? 'L' : 'R';
    if (side === 'L') needL--;
    movers.push({ ic, side });
  }
  const taken = new Set(icons.filter((i) => !movers.some((m) => m.ic === i)).map((i) => `${colOf(i, g)},${rowOf(i, g)}`));
  const free = (cols: number[]): { col: number; row: number }[] => cols.flatMap((col) => [...Array(g.rows).keys()].map((row) => ({ col, row }))).filter((c) => !taken.has(`${c.col},${c.row}`));
  const freeL = free(z.leftCols);
  const freeR = free(z.rightCols);
  const moves: Move[] = [];
  for (const { ic, side } of movers) {
    const c = (side === 'L' ? freeL : freeR).shift();
    if (!c) continue;
    taken.add(`${c.col},${c.row}`);
    moves.push({ ref: ic.ref, name: ic.name, x: Math.round(g.x0 + c.col * g.dx), y: Math.round(g.y0 + c.row * g.dy) });
  }
  return moves;
}

/** Whether every icon is in its zone with the right counts (pure). */
export function arranged(icons: readonly Icon[], g: Grid, z: Zones): { left: number; right: number; middle: number; ok: boolean } {
  const left = icons.filter((i) => z.leftCols.includes(colOf(i, g))).length;
  const right = icons.filter((i) => z.rightCols.includes(colOf(i, g))).length;
  const middle = icons.length - left - right;
  return { left, right, middle, ok: middle === 0 && left === z.nLeft && right === z.nRight };
}

const textOf = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const done = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Runs the arrangement through the hub's tools. Calling it again on an arranged desktop moves nothing. */
export async function arrangeIcons(
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  layout: Layout,
  log: (line: string) => void = () => {},
): Promise<CallToolResult> {
  const look = async (): Promise<{ icons: Icon[]; area: Area | null; err?: string }> => {
    const r = await call('xtraos__observe', { window: 'desktop', full: true, bounds: true });
    return r.isError === true ? { icons: [], area: null, err: textOf(r) } : parseDesktop(textOf(r));
  };
  const first = await look();
  if (first.err !== undefined) return done(`could not read the desktop: ${first.err}`, true);
  if (first.icons.length === 0) return done('No desktop icons found (is the desktop showing icons?).', true);
  const area = first.area ?? { x: 0, y: 0, w: Math.max(...first.icons.map((i) => i.cx + i.w)), h: Math.max(...first.icons.map((i) => i.cy + i.h)) };
  // The grid is measured once, so every round and every later call agree on the columns.
  const g = gridOf(first.icons, area);
  const z = zonesOf(first.icons.length, g, layout);
  if (z.leftCols.length + z.rightCols.length > g.cols) return done(`There are ${first.icons.length} icons but not enough columns on this desktop.`, true);
  let icons = first.icons;
  let moved = 0;
  const failed = new Map<string, string>();
  const tries = new Map<string, number>();
  for (let round = 0; round < 5 && !arranged(icons, g, z).ok; round++) {
    const moves = planRound(icons, g, z).filter((m) => !failed.has(m.ref) && (tries.get(m.ref) ?? 0) < 2);
    if (moves.length === 0) break;
    for (const m of moves) {
      tries.set(m.ref, (tries.get(m.ref) ?? 0) + 1);
      const r = await call('xtraos__drag', { window: 'desktop', from_ref: m.ref, to_x: m.x, to_y: m.y });
      const tx = textOf(r);
      if (r.isError === true) {
        if (/TARGET_OCCUPIED/.test(tx)) continue;
        if (/STOPPED|BLOCKED_BY_POLICY|NEEDS_HUMAN|USER_ACTIVE/.test(tx)) return done(`Stopped after ${moved} move(s): ${tx.split('\n')[0]}`, true);
        failed.set(m.ref, tx.split('\n')[0] ?? 'failed');
        continue;
      }
      moved++;
    }
    log(`arrange round ${round + 1}: ${moves.length} planned`);
    const again = await look();
    if (again.err === undefined && again.icons.length > 0) icons = again.icons;
  }
  const s = arranged(icons, g, z);
  const fails = [...failed.entries()].slice(0, 3).map(([ref, why]) => `${icons.find((i) => i.ref === ref)?.name ?? ref}: ${why}`);
  if (s.ok) {
    return done(
      moved === 0
        ? `Already arranged: ${s.left} icons on the left, ${s.right} on the right, none in the middle. Nothing was moved. The task is done; do not call this again.`
        : `Done: all ${icons.length} icons are arranged, ${s.left} in columns at the left edge and ${s.right} at the right edge, none in the middle (${moved} move(s)). The task is done; do not call this again.`,
    );
  }
  return done(
    `Partly arranged after ${moved} move(s): ${s.left} on the left (want ${z.nLeft}), ${s.right} on the right (want ${z.nRight}), ${s.middle} still in the middle.` +
      (fails.length > 0 ? ` Could not move: ${fails.join('; ')}.` : '') +
      ' Calling this tool again continues from here without moving the icons that are already in place.',
    moved === 0,
  );
}
