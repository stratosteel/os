/**
 * FABRIX provider (layer 2, records). Wraps FABRIX's /api/v1 as the RecordsProvider and as a small
 * gateway the MCP tools use for the verbs that have no place in the generic interface.
 *
 * Authentication: the worker's own FABRIX account (Supabase access token) as a Bearer token. The
 * server makes every request AS that account, so FABRIX's row level security and its gates apply to
 * the worker exactly as to a person. This provider never holds a service key.
 *
 * Writes carry an Idempotency-Key. A retry with the same key replays the first answer, so a worker
 * that times out and tries again never repeats the work.
 */
import { randomUUID } from 'node:crypto';
import type { FabrixGateway, JobRecord, JobStage, RecordsProvider } from '../providers.js';

export interface FabrixOptions {
  /** e.g. https://fabrix.example.test (no trailing slash needed) */
  baseUrl: string;
  /** returns a current access token; called per request so a refreshed token is picked up */
  getToken: () => Promise<string>;
  /** override for tests */
  fetchImpl?: typeof fetch;
}

export class FabrixError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'FabrixError';
  }
}

export class FabrixClient implements FabrixGateway {
  constructor(private readonly opts: FabrixOptions) {}

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const f = this.opts.fetchImpl ?? fetch;
    const token = await this.opts.getToken();
    const res = await f(this.url(path), {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* an empty body is fine for an error status */ }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? `FABRIX ${res.status}`;
      throw new FabrixError(msg, res.status, body);
    }
    return body;
  }

  async read(verb: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const body = (await this.call(`/api/v1/read/${encodeURIComponent(verb)}${q.size ? `?${q}` : ''}`, { method: 'GET' })) as { data: unknown };
    return body.data;
  }

  async write(verb: string, input: Record<string, unknown>, idempotencyKey: string = randomUUID()): Promise<unknown> {
    const body = (await this.call(`/api/v1/actions/${encodeURIComponent(verb)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    })) as { data: unknown };
    return body.data;
  }
}

// --- RecordsProvider ---------------------------------------------------------------------------

interface FabrixJobDetail {
  job: { id: string; code: string; name: string; status: string; partner_name?: string | null; owner?: string | null; created_at: string; updated_at: string };
  docs: Array<{ id: string; doc_no: string; type: string; status: string; partner_id: string | null }>;
}

const STAGE: Record<string, JobStage> = {
  open: 'inquiry', won: 'ordered', in_production: 'in_production', delivering: 'in_production',
  closed: 'closed', lost: 'lost', on_hold: 'quoting',
};

/**
 * One FABRIX job as the generic JobRecord. The id is the job code (Z-YYYY-NNN), the enquiry
 * number lives in `children`. A partner's NAME is never copied out: a supplier is a reference.
 */
export function toJobRecord(d: FabrixJobDetail): JobRecord {
  const children: JobRecord['children'] = [];
  for (const doc of d.docs) {
    const type = doc.type === 'RFQ_OUT' ? 'RFQ_OUT' : doc.type === 'QUOTE' ? 'CN' : doc.type === 'PO' ? 'PO' : null;
    if (type) children.push({ type, id: doc.doc_no, status: doc.status, counterparty: doc.partner_id ?? undefined });
  }
  const hasQuote = d.docs.some(x => x.type === 'QUOTE');
  const stage: JobStage = d.job.status === 'open' && hasQuote ? 'quoting' : (STAGE[d.job.status] ?? 'inquiry');
  return {
    id: d.job.code,
    customer: d.job.partner_name ?? '',
    title: d.job.name,
    stage,
    owner: d.job.owner ?? '',
    createdAt: d.job.created_at,
    updatedAt: d.job.updated_at,
    children,
  };
}

export class FabrixRecordsProvider implements RecordsProvider {
  constructor(private readonly client: FabrixClient) {}

  async getJob(id: string): Promise<JobRecord | null> {
    try {
      const jobs = (await this.client.read('list_jobs')) as Array<{ id: string; code: string }>;
      const hit = jobs.find(j => j.code === id || j.id === id);
      if (!hit) return null;
      return toJobRecord((await this.client.read('get_job', { id: hit.id })) as FabrixJobDetail);
    } catch (e) {
      if (e instanceof FabrixError && e.status === 422) return null;
      throw e;
    }
  }

  async listJobs(opts: { stage?: JobStage; limit?: number } = {}): Promise<JobRecord[]> {
    const rows = (await this.client.read('list_jobs', { limit: opts.limit })) as Array<{ id: string }>;
    const out: JobRecord[] = [];
    for (const r of rows) {
      const rec = toJobRecord((await this.client.read('get_job', { id: r.id })) as FabrixJobDetail);
      if (!opts.stage || rec.stage === opts.stage) out.push(rec);
    }
    return out;
  }
}
