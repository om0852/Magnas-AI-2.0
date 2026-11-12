// Copies the static files (index.html, style.css, manifest) next to the built app.js in the relay's public folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'relay', 'public');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'static'))) fs.copyFileSync(path.join(here, 'static', f), path.join(out, f));
console.log(`phone app → ${out}`);
