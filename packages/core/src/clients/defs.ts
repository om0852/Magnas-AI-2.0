/** The AI tools Magnus knows: where each keeps MCP servers, skills and rules. Data, not logic. */
import path from 'node:path';
import type { JsonShape } from '../plan-json.js';
import type { Env } from '../types.js';

export type McpTarget =
  | { format: 'json'; file: (e: Env) => string; shape: JsonShape }
  | { format: 'toml'; file: (e: Env) => string }
  /** Claude Code: read its file to plan, change it only through `claude mcp`. */
  | { format: 'claude-cli'; file: (e: Env) => string };

export interface ClientDef {
  id: string;
  name: string;
  /** The tool is installed when this folder or file exists. */
  detect: (e: Env) => string;
  mcp?: McpTarget;
  skillsDir?: (e: Env) => string;
  rulesFile?: (e: Env) => string;
  /** Shown by `magnus status`, e.g. what is not covered yet. */
  note?: string;
}

const MCP_SERVERS: JsonShape = { key: 'mcpServers', stdioType: false };

export const CLIENTS: readonly ClientDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: (e) => path.join(e.home, '.claude'),
    mcp: { format: 'claude-cli', file: (e) => path.join(e.home, '.claude.json') },
    skillsDir: (e) => path.join(e.home, '.claude', 'skills'),
    rulesFile: (e) => path.join(e.home, '.claude', 'CLAUDE.md'),
  },
  {
    id: 'codex',
    name: 'Codex',
    detect: (e) => path.join(e.home, '.codex'),
    mcp: { format: 'toml', file: (e) => path.join(e.home, '.codex', 'config.toml') },
    skillsDir: (e) => path.join(e.home, '.codex', 'skills'),
    rulesFile: (e) => path.join(e.home, '.codex', 'AGENTS.md'),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    detect: (e) => path.join(e.home, '.gemini', 'antigravity'),
    mcp: {
      format: 'json',
      file: (e) => path.join(e.home, '.gemini', 'antigravity', 'mcp_config.json'),
      shape: MCP_SERVERS,
    },
    rulesFile: (e) => path.join(e.home, '.gemini', 'GEMINI.md'),
    note: 'skills: location not confirmed yet',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    detect: (e) => path.join(e.appData, 'Code', 'User'),
    mcp: {
      format: 'json',
      file: (e) => path.join(e.appData, 'Code', 'User', 'mcp.json'),
      shape: { key: 'servers', stdioType: true },
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: (e) => path.join(e.home, '.cursor'),
    mcp: { format: 'json', file: (e) => path.join(e.home, '.cursor', 'mcp.json'), shape: MCP_SERVERS },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detect: (e) => path.join(e.home, '.codeium', 'windsurf'),
    mcp: {
      format: 'json',
      file: (e) => path.join(e.home, '.codeium', 'windsurf', 'mcp_config.json'),
      shape: MCP_SERVERS,
    },
    rulesFile: (e) => path.join(e.home, '.codeium', 'windsurf', 'memories', 'global_rules.md'),
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detect: (e) => path.join(e.appData, 'Claude', 'claude_desktop_config.json'),
    mcp: {
      format: 'json',
      file: (e) => path.join(e.appData, 'Claude', 'claude_desktop_config.json'),
      shape: MCP_SERVERS,
    },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detect: (e) => path.join(e.home, '.gemini', 'settings.json'),
    mcp: { format: 'json', file: (e) => path.join(e.home, '.gemini', 'settings.json'), shape: MCP_SERVERS },
    rulesFile: (e) => path.join(e.home, '.gemini', 'GEMINI.md'),
  },
];
