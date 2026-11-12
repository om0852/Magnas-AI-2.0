/** Copies registry skills into a tool's skills folder; only folders Magnus marked are ever changed. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ItemOp } from './types.js';

/** A skill folder with this file was written by Magnus. */
export const MARKER = '.magnus-managed';

/** A hash of a folder's files (relative paths and contents), without the marker. */
export function hashDir(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (r !== MARKER) {
        h.update(r).update('\0').update(fs.readFileSync(path.join(dir, r))).update('\0');
      }
    }
  };
  walk('');
  return h.digest('hex');
}

/** What sync would do for each skill in `targetDir` (reads only). */
export function planSkills(
  sourceDir: string,
  targetDir: string,
  wanted: readonly string[],
  managed: readonly string[],
): ItemOp[] {
  const ops: ItemOp[] = [];
  for (const name of wanted) {
    const target = path.join(targetDir, name);
    if (!fs.existsSync(target)) {
      ops.push({ name, op: 'add' });
    } else if (!fs.existsSync(path.join(target, MARKER))) {
      ops.push({ name, op: 'conflict', detail: 'a skill folder with this name exists and is not managed by Magnus' });
    } else {
      const same = hashDir(path.join(sourceDir, name)) === hashDir(target);
      ops.push({ name, op: same ? 'unchanged' : 'update' });
    }
  }
  for (const name of managed) {
    if (wanted.includes(name)) continue;
    if (fs.existsSync(path.join(targetDir, name, MARKER))) ops.push({ name, op: 'remove' });
  }
  return ops;
}

/** Carries out the add / update / remove operations of a plan. */
export function applySkills(sourceDir: string, targetDir: string, ops: readonly ItemOp[]): void {
  for (const { name, op } of ops) {
    const target = path.join(targetDir, name);
    if (op === 'remove' || op === 'update') {
      // Only a folder Magnus marked may be deleted (checked again at write time).
      if (!fs.existsSync(path.join(target, MARKER))) continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (op === 'add' || op === 'update') {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(path.join(sourceDir, name), target, { recursive: true });
      fs.writeFileSync(path.join(target, MARKER), 'Written by Magnus. Edit the skill in ~/.magnus/skills, then run "magnus sync".\n');
    }
  }
}
