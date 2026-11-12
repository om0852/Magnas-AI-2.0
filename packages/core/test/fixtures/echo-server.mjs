// A tiny real MCP server for the end-to-end hub test: one tool that echoes, with a label from its env.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const label = process.env.ECHO_LABEL ?? 'echo';
const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {} }, instructions: `Use say to echo (${label}).` });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'say', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `${label}: ${req.params.arguments?.text}` }],
}));
await server.connect(new StdioServerTransport());
