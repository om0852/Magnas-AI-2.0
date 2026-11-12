/** A block of lines Magnus owns inside a file that otherwise belongs to the user (pure). */

export interface Markers {
  /** A line starting with this opens the block. */
  beginPrefix: string;
  /** The full opening line written by Magnus. */
  beginLine: string;
  /** The closing line (also matched as a prefix). */
  endLine: string;
}

export interface Split {
  before: string;
  /** The block's content without its marker lines; null when there is no block. */
  body: string | null;
  after: string;
  /** An opening marker without a closing one: the file is left alone. */
  malformed: boolean;
}

/** The line ending the file uses (new files: \n). */
export function eolOf(text: string | null): string {
  return text !== null && text.includes('\r\n') ? '\r\n' : '\n';
}

export function splitBlock(text: string, m: Markers): Split {
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.startsWith(m.beginPrefix));
  if (begin < 0) return { before: text, body: null, after: '', malformed: false };
  const end = lines.findIndex((l, i) => i > begin && l.startsWith(m.endLine));
  if (end < 0) return { before: text, body: null, after: '', malformed: true };
  return {
    before: lines.slice(0, begin).join('\n'),
    body: lines.slice(begin + 1, end).join('\n'),
    after: lines.slice(end + 1).join('\n'),
    malformed: false,
  };
}

/**
 * The file with the block replaced (`body` null = block removed). The block keeps its place;
 * a new block goes to the end. The user's text is kept; only blank lines next to the block change.
 */
export function joinBlock(split: Split, body: string | null, m: Markers, eol: string): string {
  const block = body === null ? '' : [m.beginLine, ...body.split('\n'), m.endLine].join(eol);
  const parts = [split.before.trimEnd(), block, split.after.trim()].filter((p) => p !== '');
  return parts.length === 0 ? '' : parts.join(eol + eol) + eol;
}

/** Block content compared without regard to line endings or outer blank lines. */
export function sameBody(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\r/g, '').trim();
  return norm(a) === norm(b);
}
