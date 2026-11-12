/** Plans the managed rules block in a tool's own rules file (CLAUDE.md, AGENTS.md, GEMINI.md) (pure). */
import { eolOf, joinBlock, sameBody, splitBlock, type Markers } from './blocks.js';
import type { Op } from './types.js';

export const RULES_MARKERS: Markers = {
  beginPrefix: '<!-- >>> magnus rules',
  beginLine: '<!-- >>> magnus rules (managed: edit ~/.magnus/rules, then run "magnus sync") -->',
  endLine: '<!-- <<< magnus rules',
};

const END_LINE = '<!-- <<< magnus rules -->';

export interface RulesPlan {
  /** The new file text, or null when nothing changes. */
  text: string | null;
  op: Op;
  detail?: string;
}

/** `current`: the file's text (null = no file). `rules`: '' removes the block. */
export function planRules(current: string | null, rules: string): RulesPlan {
  const split = splitBlock(current ?? '', RULES_MARKERS);
  if (split.malformed) {
    return { text: null, op: 'skip', detail: 'the magnus rules block has no end marker: left untouched' };
  }
  const markers: Markers = { ...RULES_MARKERS, endLine: END_LINE };
  const eol = eolOf(current);
  if (rules === '') {
    if (split.body === null) return { text: null, op: 'unchanged' };
    return { text: joinBlock(split, null, markers, eol), op: 'remove' };
  }
  if (split.body !== null && sameBody(split.body, rules)) return { text: null, op: 'unchanged' };
  return { text: joinBlock(split, rules, markers, eol), op: split.body === null ? 'add' : 'update' };
}
