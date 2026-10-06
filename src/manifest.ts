/**
 * layers.yaml loader and validator. An instance file must keep the six layers and the six gates;
 * it may change providers, names and statuses. Run: node dist/src/manifest.js <file>
 */
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import * as z from 'zod/v4';

const Status = z.enum(['planned', 'skeleton', 'coded', 'building', 'live', 'retired']);
const GateStatus = z.enum(['open', 'passed', 'failed']);

const Layer = z.object({
  purpose: z.string().min(3),
  provider: z.string().optional(),
  options: z.array(z.string()).optional(),
  status: Status,
}).loose();

export const ManifestSchema = z.object({
  schema: z.literal('stratosteel-os/layers/v0.1'),
  company: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'company.id: lowercase letters, digits and hyphens'),
    name: z.string().min(1),
    timezone: z.string().min(3),
    languages: z.array(z.string().length(2)).min(1),
  }),
  layers: z.object({
    L1_tenant: Layer.extend({ provider: z.enum(['m365', 'google', 'none']) }),
    L2_records: Layer.extend({ provider: z.enum(['fabrix', 'odoo', 'none']) }),
    L3_runtime: Layer.extend({ provider: z.enum(['managed-agents', 'forge', 'none']), budget_usd_cap: z.number().nonnegative() }),
    L4_memory: Layer.extend({ provider: z.enum(['github', 'none']), repo: z.string(), ledger_path: z.string(), state_page: z.string() }),
    L5_access: Layer.extend({ provider: z.literal('mcp'), transport: z.enum(['stdio', 'http']) }),
    L6_gates: Layer.extend({ policy: z.string() }),
  }),
  gates: z.object({
    G1: z.object({ name: z.string(), status: GateStatus }).loose(),
    G2: z.object({ name: z.string(), status: GateStatus }).loose(),
    G3: z.object({ name: z.string(), status: GateStatus }).loose(),
    G4: z.object({ name: z.string(), status: GateStatus }).loose(),
    G5: z.object({ name: z.string(), status: GateStatus }).loose(),
    G6: z.object({ name: z.string(), status: GateStatus }).loose(),
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(text: string): Manifest {
  const data = yaml.load(text);
  return ManifestSchema.parse(data);
}

export async function loadManifest(path: string): Promise<Manifest> {
  return parseManifest(await readFile(path, 'utf8'));
}

/** Gate order is fixed: a later gate cannot pass while an earlier one is open or failed. */
export function gateOrderErrors(m: Manifest): string[] {
  const order = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'] as const;
  const errors: string[] = [];
  let blocked = false;
  for (const g of order) {
    const st = m.gates[g].status;
    if (blocked && st === 'passed') errors.push(`${g} passed while an earlier gate is not passed`);
    if (st !== 'passed') blocked = true;
  }
  return errors;
}

const isMain = process.argv[1] && /manifest\.js$/.test(process.argv[1]);
if (isMain) {
  const file = process.argv[2] ?? 'layers.yaml';
  loadManifest(file)
    .then((m) => {
      const errs = gateOrderErrors(m);
      if (errs.length) {
        console.error(errs.join('\n'));
        process.exit(1);
      }
      console.log(`manifest ok: ${m.company.id}; L1=${m.layers.L1_tenant.provider} L2=${m.layers.L2_records.provider} L3=${m.layers.L3_runtime.provider} L4=${m.layers.L4_memory.provider} L5=${m.layers.L5_access.provider} L6=${m.layers.L6_gates.policy}`);
    })
    .catch((e) => {
      console.error(String(e));
      process.exit(1);
    });
}
