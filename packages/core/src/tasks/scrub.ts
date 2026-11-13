/**
 * Masks secrets in text before it is stored or leaves the PC (ADR 0013). Errs on the side of
 * hiding: a long random-looking value after a word like "key" or "token" is hidden too.
 */

const RULES: [RegExp, string][] = [
  // Private keys (PEM blocks).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[hidden private key]'],
  // Well-known token shapes.
  [/\b(sk|rk|pk)-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, '[hidden]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[hidden]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[hidden]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[hidden]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[hidden]'],
  [/\bAQ\.[A-Za-z0-9_-]{20,}/g, '[hidden]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, '[hidden]'], // Telegram bot token
  [/\bmgn_[A-Za-z0-9_-]{20,}/g, '[hidden]'], // Magnus key
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[hidden jwt]'],
  // Credentials in URLs: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[hidden]@'],
  // Authorization headers.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [hidden]'],
  // key = value / key: value where the name says secret.
  [/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)(?!\[hidden)(?!(?:bearer|basic)\s)([^\s"',;]{6,})/gi, '$1$2[hidden]'],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/** Scrubbed, on one line if asked, and cut to `max` characters. */
export function safeText(text: unknown, max: number, oneLine = false): string {
  let s = scrubSecrets(typeof text === 'string' ? text : JSON.stringify(text ?? ''));
  if (oneLine) s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
