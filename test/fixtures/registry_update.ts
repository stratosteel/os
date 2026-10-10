/**
 * One independent process that changes the document registry, for the A11 cross-process race:
 *   node dist/test/fixtures/registry_update.js <config.json>
 * It prints "ready", waits at the barrier file, sleeps a random 0 to maxDelayMs milliseconds, adds the configured
 * revision under the registry's lock (the version fence) and prints "result:<json>" with the line's sequence number.
 */
import { access, readFile } from 'node:fs/promises';
import { DocumentRegistry, type DocumentKind } from '../../src/document_registry.js';

interface UpdateConfig {
  registryDir: string;
  barrierPath: string;
  documentId: string;
  revision: string;
  filename: string;
  kind: DocumentKind;
  /** The new revision's bytes, base64. */
  bytes: string;
  maxDelayMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as UpdateConfig;
const registry = new DocumentRegistry(config.registryDir);
process.stdout.write('ready\n');
for (;;) {
  try {
    await access(config.barrierPath);
    break;
  } catch {
    await sleep(1);
  }
}
await sleep(Math.floor(Math.random() * (config.maxDelayMs + 1)));
const ev = await registry.addRevision(config.documentId, { revision: config.revision, filename: config.filename, kind: config.kind, bytes: Buffer.from(config.bytes, 'base64') }, 'updater-process');
process.stdout.write(`result:${JSON.stringify({ seq: ev.seq, at: ev.at, pid: process.pid })}\n`);
process.exit(0);
