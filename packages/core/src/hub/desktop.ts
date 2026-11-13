/**
 * Desktop helpers (ADR 0016): real-mouse work on the desktop (moving icons) needs the desktop
 * visible, and Windows does not let a background program press Win+D. These tools minimise the
 * windows that cover it through XtraOS (window_bounds, which works in the background and passes
 * XtraOS's policy and log), and put them back afterwards.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const SHOW_DESKTOP = 'magnus__show_desktop';
export const RESTORE_WINDOWS = 'magnus__restore_windows';

export const DESKTOP_TOOLS: Tool[] = [
  {
    name: 'magnus__arrange_desktop_icons',
    description:
      'Arranges ALL desktop icons in one call (use this for any "arrange / rearrange / sort my desktop icons" request instead of dragging icons one by one): layout "left-right" puts half in neat columns at the left edge and half at the right edge, "left" or "right" puts all of them at that edge. It clears the desktop, moves every icon, checks, restores the windows, and reports how many were placed.',
    inputSchema: { type: 'object', properties: { layout: { type: 'string', enum: ['left-right', 'left', 'right'], description: 'Default left-right' } } },
  },
  {
    name: SHOW_DESKTOP,
    description:
      'Minimises every window that covers the desktop, so desktop icons can be dragged (use before moving icons, or when a drag says TARGET_OBSCURED). Remembers them: call magnus__restore_windows when done.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: RESTORE_WINDOWS,
    description: 'Restores the windows that magnus__show_desktop minimised (also done by itself when the task ends).',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface ListedWindow {
  ref: string;
  process: string;
  title: string;
  w: number;
  h: number;
  flags: string[];
}

/** Parses XtraOS list_windows text: `w123 chrome "Title" x,y WxH [minimized] [focused] [elevated] [agent]` (pure). */
export function parseWindows(text: string): ListedWindow[] {
  const out: ListedWindow[] = [];
  for (const line of text.split('\n')) {
    const m = /^(w\d+) (\S+) "(.*)" -?\d+,-?\d+ (\d+)x(\d+)(.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ ref: m[1] as string, process: m[2] as string, title: m[3] as string, w: Number(m[4]), h: Number(m[5]), flags: (m[6] ?? '').trim().split(/\s+/).filter(Boolean) });
  }
  return out;
}

/** The windows to minimise: visible, not admin (XtraOS cannot touch those), not the desktop itself (pure). */
export function coveringWindows(ws: readonly ListedWindow[]): ListedWindow[] {
  return ws.filter(
    (w) =>
      !w.flags.includes('minimized') &&
      !w.flags.includes('elevated') &&
      w.w > 0 &&
      w.h > 0 &&
      !(w.process.toLowerCase() === 'explorer' && (w.title === '' || w.title === 'Program Manager')),
  );
}

const textOf = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const done = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export class DesktopHelper {
  private minimized: string[] = [];

  constructor(private readonly call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>) {}

  get pending(): number {
    return this.minimized.length;
  }

  async show(): Promise<CallToolResult> {
    const list = await this.call('xtraos__list_windows', {});
    if (list.isError === true) return done(`could not list the windows: ${textOf(list)}`, true);
    const cover = coveringWindows(parseWindows(textOf(list)));
    const failed: string[] = [];
    for (const w of cover) {
      const r = await this.call('xtraos__window_bounds', { window: w.ref, state: 'minimize' });
      if (r.isError === true) failed.push(`${w.title || w.process}: ${textOf(r).split('\n')[0] ?? ''}`);
      else if (!this.minimized.includes(w.ref)) this.minimized.push(w.ref);
    }
    const ok = cover.length - failed.length;
    return done(
      `Minimised ${ok} window(s); the desktop is visible now.${failed.length > 0 ? ` Not minimised: ${failed.join('; ')}.` : ''} Call ${RESTORE_WINDOWS} when you are done with the desktop.`,
      ok === 0 && cover.length > 0,
    );
  }

  async restore(): Promise<CallToolResult> {
    const refs = this.minimized;
    this.minimized = [];
    let ok = 0;
    for (const ref of refs) {
      const r = await this.call('xtraos__window_bounds', { window: ref, state: 'restore' });
      if (r.isError !== true) ok++;
    }
    return done(refs.length === 0 ? 'Nothing to restore.' : `Restored ${ok} of ${refs.length} window(s).`);
  }
}
