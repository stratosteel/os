#!/usr/bin/env node
/** stdio entrypoint: `node dist/src/index.js` (or the bin `stratosteel-os-mcp`). Logs go to stderr only. */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const { server, tools, ctx } = await createServer();
console.error(`stratosteel-os mcp: caller=${ctx.caller} role=${ctx.role} tools=${tools.map((t) => t.name).join(',')}`);
await server.connect(new StdioServerTransport());
