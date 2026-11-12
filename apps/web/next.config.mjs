import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
export default {
  // The core reads and writes files and starts processes: Node loads it as it is, unbundled.
  serverExternalPackages: ['@magnus/core'],
  // The repository root (npm workspaces), so file tracing does not guess.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  poweredByHeader: false,
};
