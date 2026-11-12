/** The HTTP way in: Streamable HTTP on 127.0.0.1 only, the Magnus key on every request (ADR 0005). */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { keyMatches } from './key.js';

export const HTTP_PATH = '/mcp';
export const DEFAULT_PORT = 8787;
const MAX_BODY = 4 * 1024 * 1024;

export interface Refusal {
  status: number;
  message: string;
}

/** What a request must satisfy before anything else happens (pure). */
export function checkRequest(
  req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
  keyHash: string,
  port: number,
): Refusal | null {
  if (req.headers['origin'] !== undefined) return { status: 403, message: 'requests from web pages (Origin header) are not accepted' };
  const host = String(req.headers['host'] ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, message: `Host must be 127.0.0.1:${port}` };
  if ((req.url ?? '').split('?')[0] !== HTTP_PATH) return { status: 404, message: `the endpoint is ${HTTP_PATH}` };
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers['authorization'] ?? ''));
  if (!m || !keyMatches(keyHash, m[1] as string)) return { status: 401, message: 'missing or wrong key (Authorization: Bearer <Magnus key>)' };
  return null;
}

function reply(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** Serves MCP on 127.0.0.1:port (0 = any free port); a new MCP server per request (stateless). */
export async function serveHttp(makeServer: () => Promise<Server>, port: number, keyHash: string): Promise<http.Server> {
  let actual = port;
  const srv = http.createServer((req, res) => {
    void (async () => {
      try {
        const bad = checkRequest(req, keyHash, actual);
        if (bad) return reply(res, bad.status, bad.message);
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          return reply(res, 405, 'POST JSON-RPC to /mcp (stateless endpoint)');
        }
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) {
          n += (c as Buffer).length;
          if (n > MAX_BODY) return reply(res, 413, 'request body over 4 MB');
          chunks.push(c as Buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reply(res, 400, 'body is not JSON');
        }
        const server = await makeServer();
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no session ids: stateless
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) reply(res, 500, e instanceof Error ? e.message : String(e));
      }
    })();
  });
  await new Promise<void>((ok, fail) => {
    srv.once('error', fail);
    srv.listen(port, '127.0.0.1', () => ok());
  });
  actual = (srv.address() as AddressInfo).port;
  return srv;
}
