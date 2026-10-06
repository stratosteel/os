/**
 * MCP server (layer 5). Registers the tool definitions of tools.ts with the MCP SDK v2.
 * Configuration by environment, no secrets in files:
 *   OS_CALLER   identity of the connected client (agent id or person's name), default "agent"
 *   OS_ROLE     agent | human (human mounts approval_decide), default agent
 *   OS_STATE    directory for local state (approvals.jsonl, ledger.md when the memory provider is local), default ./state
 *   OS_PROVIDERS mock (default) | later: m365, google, fabrix, odoo, github, chosen per layer from the manifest
 *   OS_STATE_PAGE path of STATE_OF_THE_BUILD.md for the state_of_build tool (optional)
 */
import { McpServer } from '@modelcontextprotocol/server';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ApprovalQueue } from './approvals.js';
import { mockProviders } from './mock.js';
import { DEFAULT_POLICY, type PolicyConfig } from './policy.js';
import type { Providers } from './providers.js';
import { buildTools, type ToolContext, type ToolDef } from './tools.js';

export interface ServerOptions {
  caller?: string;
  role?: 'agent' | 'human';
  stateDir?: string;
  providers?: Providers;
  policy?: PolicyConfig;
  statePagePath?: string;
}

export async function createContext(opts: ServerOptions = {}): Promise<ToolContext> {
  const stateDir = opts.stateDir ?? process.env.OS_STATE ?? path.resolve('state');
  await mkdir(stateDir, { recursive: true });
  const providers = opts.providers ?? mockProviders(path.join(stateDir, 'ledger.md'), opts.statePagePath ?? process.env.OS_STATE_PAGE);
  return {
    providers,
    approvals: new ApprovalQueue(path.join(stateDir, 'approvals.jsonl')),
    policy: opts.policy ?? DEFAULT_POLICY,
    caller: opts.caller ?? process.env.OS_CALLER ?? 'agent',
    role: opts.role ?? ((process.env.OS_ROLE === 'human' ? 'human' : 'agent') as 'agent' | 'human'),
  };
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function registerTools(server: McpServer, tools: ToolDef[]): void {
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, async (input: unknown) => {
      try {
        return textResult(await t.handler(input as never));
      } catch (e) {
        return { ...textResult(`error: ${e instanceof Error ? e.message : String(e)}`), isError: true };
      }
    });
  }
}

export async function createServer(opts: ServerOptions = {}): Promise<{ server: McpServer; tools: ToolDef[]; ctx: ToolContext }> {
  const ctx = await createContext(opts);
  const tools = buildTools(ctx);
  const server = new McpServer({ name: 'stratosteel-os', version: '0.1.0' });
  registerTools(server, tools);
  return { server, tools, ctx };
}
