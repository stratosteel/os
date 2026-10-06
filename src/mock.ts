/**
 * Mock providers over in-memory fixtures. Generic, invented data: no real customer, supplier or partner.
 * They let the access door, the policy and the approval queue run end to end before any tenant exists,
 * and they are the reference behaviour every real provider must match (same shapes, same search semantics).
 */
import type { FileEntry, FilesProvider, JobRecord, MailMessage, MailProvider, MemoryProvider, Providers, RecordsProvider } from './providers.js';
import { appendEntry, readTail, type LedgerEntry } from './ledger.js';

export const FIXTURE_JOBS: JobRecord[] = [
  {
    id: 'DOP-2026-001',
    customer: 'Example Industrial GmbH',
    title: 'Steel structure, production hall 40 x 18 m, EXC2, galvanized, erected',
    stage: 'quoting',
    owner: 'M. Example',
    createdAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-06T16:00:00Z',
    children: [
      { type: 'RFQ_OUT', id: 'RFQ-2610-001', status: 'answered', counterparty: 'SUP-STEEL-01' },
      { type: 'RFQ_OUT', id: 'RFQ-2610-002', status: 'answered', counterparty: 'SUP-FAB-02' },
      { type: 'RFQ_OUT', id: 'RFQ-2610-003', status: 'open', counterparty: 'SUP-GALV-01' },
      { type: 'RFQ_OUT', id: 'RFQ-2610-004', status: 'answered', counterparty: 'SUP-TRANS-01' },
      { type: 'CN', id: 'CN-2026-0101', status: 'draft rev 2' },
    ],
    sourcingPlan: [
      { package: 'steel supply', supplierRef: 'SUP-STEEL-01', status: 'quoted' },
      { package: 'cutting and welding', supplierRef: 'SUP-FAB-02', status: 'quoted' },
      { package: 'hot-dip galvanizing', supplierRef: 'SUP-GALV-01', status: 'open' },
      { package: 'transport DE', supplierRef: 'SUP-TRANS-01', status: 'quoted' },
      { package: 'erection', supplierRef: 'SUP-ERECT-01', status: 'open' },
    ],
  },
  {
    id: 'DOP-2026-002',
    customer: 'Sample Machines Oy',
    title: 'Machined housing 3.2 t, 42CrMo4, QT, 2 pieces',
    stage: 'quoted',
    owner: 'M. Example',
    createdAt: '2026-09-20T09:30:00Z',
    updatedAt: '2026-10-05T10:00:00Z',
    children: [{ type: 'CN', id: 'CN-2026-0098', status: 'sent rev 3' }],
  },
];

export const FIXTURE_MAIL: MailMessage[] = [
  {
    id: 'msg-001',
    mailbox: 'rfq@',
    from: 'purchasing@example-industrial.example',
    to: ['rfq@template.example'],
    subject: 'Inquiry: production hall 40x18 m, EXC2',
    receivedAt: '2026-10-01T07:55:00Z',
    snippet: 'Please quote the attached hall structure incl. galvanizing, transport and erection ...',
    attachments: [{ name: 'hall_40x18_rev0.pdf', bytes: 2_400_000 }],
    jobId: 'DOP-2026-001',
  },
  {
    id: 'msg-002',
    mailbox: 'rfq@',
    from: 'offers@sup-steel-01.example',
    to: ['rfq@template.example'],
    subject: 'RE: RFQ-2610-001 steel supply S355J2',
    receivedAt: '2026-10-03T12:10:00Z',
    snippet: 'Our offer for 48 t S355J2 profiles, delivery week 44 ...',
    attachments: [{ name: 'offer_RFQ-2610-001.pdf', bytes: 310_000 }],
    jobId: 'DOP-2026-001',
  },
  {
    id: 'msg-003',
    mailbox: 'office@',
    from: 'm.example@template.example',
    to: ['buyer@sample-machines.example'],
    subject: 'Quotation CN-2026-0098 rev 3, machined housing 42CrMo4',
    receivedAt: '2026-10-05T09:58:00Z',
    snippet: 'Please find attached our quotation revision 3 ...',
    attachments: [{ name: 'CN-2026-0098_rev3.pdf', bytes: 540_000 }],
    jobId: 'DOP-2026-002',
  },
];

export const FIXTURE_FILES: FileEntry[] = [
  { id: 'f-001', library: 'Jobs', path: '/Jobs/DOP-2026-001/inquiry/hall_40x18_rev0.pdf', name: 'hall_40x18_rev0.pdf', modifiedAt: '2026-10-01T08:02:00Z', bytes: 2_400_000, jobId: 'DOP-2026-001', revision: '0' },
  { id: 'f-002', library: 'Jobs', path: '/Jobs/DOP-2026-001/rfq_out/RFQ-2610-001_steel.pdf', name: 'RFQ-2610-001_steel.pdf', modifiedAt: '2026-10-02T10:00:00Z', bytes: 180_000, jobId: 'DOP-2026-001' },
  { id: 'f-003', library: 'Quotes', path: '/Quotes/2026/CN-2026-0098_rev3.pdf', name: 'CN-2026-0098_rev3.pdf', modifiedAt: '2026-10-05T09:50:00Z', bytes: 540_000, jobId: 'DOP-2026-002', revision: '3' },
  { id: 'f-004', library: 'Quotes', path: '/Quotes/2026/CN-2026-0098_rev2.pdf', name: 'CN-2026-0098_rev2.pdf', modifiedAt: '2026-09-28T15:20:00Z', bytes: 530_000, jobId: 'DOP-2026-002', revision: '2' },
];

function matches(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const h = hay.toLowerCase();
  return q.split(/\s+/).every((w) => h.includes(w));
}

export class MockMail implements MailProvider {
  constructor(private readonly items: MailMessage[] = FIXTURE_MAIL) {}
  async searchMail(query: string, opts: { mailbox?: string; limit?: number } = {}): Promise<MailMessage[]> {
    const out = this.items.filter((m) => (!opts.mailbox || m.mailbox === opts.mailbox) &&
      matches([m.subject, m.from, m.to.join(' '), m.snippet, m.jobId ?? '', m.attachments.map((a) => a.name).join(' ')].join(' '), query));
    return out.slice(0, opts.limit ?? 20);
  }
  async getMessage(id: string): Promise<MailMessage | null> {
    return this.items.find((m) => m.id === id) ?? null;
  }
}

export class MockFiles implements FilesProvider {
  constructor(private readonly items: FileEntry[] = FIXTURE_FILES) {}
  async searchFiles(query: string, opts: { library?: string; jobId?: string; limit?: number } = {}): Promise<FileEntry[]> {
    const out = this.items.filter((f) => (!opts.library || f.library === opts.library) && (!opts.jobId || f.jobId === opts.jobId) &&
      matches([f.name, f.path, f.jobId ?? '', f.revision ?? ''].join(' '), query));
    return out.slice(0, opts.limit ?? 20);
  }
}

export class MockRecords implements RecordsProvider {
  constructor(private readonly items: JobRecord[] = FIXTURE_JOBS) {}
  async getJob(id: string): Promise<JobRecord | null> {
    return this.items.find((j) => j.id === id) ?? null;
  }
  async listJobs(opts: { stage?: JobRecord['stage']; limit?: number } = {}): Promise<JobRecord[]> {
    return this.items.filter((j) => !opts.stage || j.stage === opts.stage).slice(0, opts.limit ?? 50);
  }
}

/** File-backed memory provider: a local ledger file and a local state page (the GitHub provider replaces it). */
export class FileMemory implements MemoryProvider {
  constructor(private readonly ledgerPath: string, private readonly statePagePath?: string) {}
  async appendLedger(line: LedgerEntry): Promise<string> {
    return appendEntry(this.ledgerPath, line);
  }
  async readLedgerTail(n = 20): Promise<string[]> {
    const entries = await readTail(this.ledgerPath, n);
    return entries.map((e) => `${e.when} | ${e.from} | ${e.to} | ${e.task} | ${e.status} | ${e.evidence}`);
  }
  async readStatePage(): Promise<string> {
    if (!this.statePagePath) return 'state page not configured';
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(this.statePagePath, 'utf8');
    } catch {
      return 'state page not found';
    }
  }
}

export function mockProviders(ledgerPath: string, statePagePath?: string): Providers {
  return { mail: new MockMail(), files: new MockFiles(), records: new MockRecords(), memory: new FileMemory(ledgerPath, statePagePath) };
}
