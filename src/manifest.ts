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

/** What a GitHub token looks like (classic and fine-grained prefixes): refused in configuration, redacted from messages. */
export const GITHUB_TOKEN_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;

/**
 * A credential is configured by the NAME of the environment variable that holds it, never by its value. The errors never
 * repeat the value: a token pasted into the configuration must not be echoed into a log by the check that refuses it.
 */
export function envVarNameErrors(name: unknown): string[] {
  if (typeof name !== 'string' || !name.trim()) return ['must name an environment variable, for example OS_GITHUB_TOKEN'];
  if (/^(gh[pousr]_|github_pat_)/i.test(name.trim())) return ['looks like a token, not the name of an environment variable; the value is not repeated here; remove it from the file and rotate it'];
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) return ['must be an environment variable name: capital letters, digits and underscores, not starting with a digit'];
  return [];
}

const EnvVarName = z.string().superRefine((value, ctx) => {
  for (const message of envVarNameErrors(value)) ctx.addIssue({ code: 'custom', message: `token_env ${message}` });
});

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
    L4_memory: Layer.extend({
      provider: z.enum(['github', 'none']), repo: z.string(), ledger_path: z.string(), state_page: z.string(),
      /** Branch of the memory repository; the repository's default branch when absent. */
      branch: z.string().min(1).optional(),
      /** Name of the environment variable holding the GitHub token (src/providers/github.ts). */
      token_env: EnvVarName.optional(),
      /** Machine channel between AI roles (src/bus/): its namespace directory inside the bus repository. */
      bus: z.object({ namespace: z.string().min(1), branch: z.string().min(1).optional() }).loose().optional(),
    }),
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

type GateId = keyof Manifest['gates'];

/**
 * Gate dependencies, as in the Depends on column of ROADMAP.md. Gates are not passed in number order: G4, the
 * metadata-only bus proof, does not wait for G3; G5 depends on G3 and G6 on G5.
 */
export const GATE_DEPENDENCIES: Readonly<Record<GateId, readonly GateId[]>> = {
  G1: [],
  G2: ['G1'],
  G3: ['G1'],
  G4: [],
  G5: ['G3'],
  G6: ['G5'],
};

/** A gate cannot pass while a gate it depends on is open or failed. This checks recorded statuses, not evidence. */
export function gateOrderErrors(m: Manifest): string[] {
  const errors: string[] = [];
  for (const [gate, deps] of Object.entries(GATE_DEPENDENCIES) as [GateId, readonly GateId[]][]) {
    if (m.gates[gate].status !== 'passed') continue;
    for (const dep of deps) {
      if (m.gates[dep].status !== 'passed') errors.push(`${gate} passed while ${dep}, a gate it depends on, is not passed`);
    }
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
