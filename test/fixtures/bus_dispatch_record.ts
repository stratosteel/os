/**
 * The test dispatcher of the bus gate tests, called by the bus CLI as an argument vector:
 *   node dist/test/fixtures/bus_dispatch_record.js <queue.jsonl> <to> <event> <token>
 * It appends one JSON line per call to the queue file: the dispatch counter and the event queue the fake scheduler reads.
 * In production the same place holds `gh workflow run` or an HTTP call.
 */
import { appendFileSync } from 'node:fs';

const [queue, to, event, token] = process.argv.slice(2);
if (!queue || !to || !event || !token) {
  process.stderr.write('usage: bus_dispatch_record.js <queue.jsonl> <to> <event> <token>\n');
  process.exit(2);
}
appendFileSync(queue, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, to, event, token, env_to: process.env.OS_BUS_DISPATCH_TO ?? null })}\n`, 'utf8');
