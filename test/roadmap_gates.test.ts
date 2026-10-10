/**
 * Pins finding G3-MAP of the independent review of 2026-10-07: the G3 acceptance mapping and the gate order.
 * A05 is two workers with one intended send (an idempotent send intent), A09 is timeout, restart and reconciliation
 * before any retry, A11 is a changed drawing invalidating the approval. Gates follow explicit dependencies, not their
 * numbers: G4 does not depend on G3, G5 depends on G3 and G6 on G5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as manifest from '../src/manifest.js';

const doc = (file: string) => readFile(path.resolve(file), 'utf8');

/** Rows of the gate table in ROADMAP.md: gate id -> [meaning, code needed, depends on]. */
function gateRows(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*(G[1-6])\s*\|(.*)\|\s*$/.exec(line);
    if (m) rows.set(m[1], m[2].split('|').map((cell) => cell.trim()));
  }
  return rows;
}

test('G3-MAP: ROADMAP.md maps A05, A09 and A11 to the canonical acceptance tests; no document keeps the old mapping', async () => {
  const g3 = gateRows(await doc('ROADMAP.md')).get('G3')?.[0] ?? '';
  assert.match(g3, /A05[^;]*two workers[^;]*one intended send/i);
  assert.match(g3, /A09[^;]*timeout[^;]*restart[^;]*reconciliation before any retry/i);
  assert.match(g3, /A11[^;]*changed drawing[^;]*invalidates the approval/i);
  for (const file of ['ROADMAP.md', 'docs/LAYERS.md']) {
    const text = await doc(file);
    for (const old of [/A05\W{0,3}revision-bound release/i, /A09\W{0,3}send record/i, /A11\W{0,3}ambiguous result reconciliation/i]) {
      assert.doesNotMatch(text, old, `${file} keeps the old mapping ${old}`);
    }
  }
});

test('G3-MAP: gates follow the Depends on column, not their numbers', async () => {
  const roadmap = await doc('ROADMAP.md');
  const fromRoadmap = Object.fromEntries([...gateRows(roadmap)].map(([gate, cells]) => [gate, (cells[2]?.match(/\bG[1-6]\b/g) ?? []).sort()]));
  assert.deepEqual(fromRoadmap, { G1: [], G2: ['G1'], G3: ['G1'], G4: [], G5: ['G3'], G6: ['G5'] });
  assert.deepEqual(manifest.GATE_DEPENDENCIES, fromRoadmap, 'the manifest check uses the roadmap dependencies');
  assert.match(roadmap, /G4 does not depend on G3/);

  const yaml = await doc('layers.yaml');
  const passed = (...gates: string[]) => {
    let text = yaml;
    for (const g of gates) text = text.replace(new RegExp(`(  ${g}: \\{[^}]*status: )open`), '$1passed');
    return manifest.gateOrderErrors(manifest.parseManifest(text));
  };
  // G4, the metadata-only bus proof, may pass before mail cutover and before G3.
  assert.deepEqual(passed('G4'), []);
  assert.deepEqual(passed('G1', 'G3', 'G4'), []);
  // A gate never passes before a gate it depends on.
  assert.match(passed('G2').join('\n'), /G2 passed while G1/);
  assert.match(passed('G3').join('\n'), /G3 passed while G1/);
  assert.match(passed('G1', 'G5').join('\n'), /G5 passed while G3/);
  assert.match(passed('G1', 'G2', 'G3', 'G4', 'G6').join('\n'), /G6 passed while G5/);
  assert.deepEqual(passed('G1', 'G2', 'G3', 'G4', 'G5', 'G6'), []);
});
