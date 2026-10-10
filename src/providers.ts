/**
 * Provider interfaces for layers 1, 2 and 4. The MCP server (layer 5) talks only to these interfaces.
 * Real providers (Microsoft Graph, Google Workspace, FABRIX, Odoo, GitHub) implement them one by one;
 * `mock.ts` implements them over fixtures so the server, the policy and the tests run without any tenant.
 */
import type { SendTransport } from './transport.js';

export interface MailMessage {
  id: string;
  mailbox: string;          // e.g. rfq@, office@, archiv@
  from: string;
  to: string[];
  subject: string;
  receivedAt: string;       // ISO
  snippet: string;
  attachments: { name: string; bytes: number }[];
  /** Job the message belongs to, if a person or a worker linked it (DOP id). */
  jobId?: string;
}

export interface FileEntry {
  id: string;
  library: string;          // e.g. Jobs, Quotes, Drawings, Archive
  path: string;
  name: string;
  modifiedAt: string;
  bytes: number;
  jobId?: string;
  /** Revision of a drawing or quote, when the file carries one. */
  revision?: string;
}

export type JobStage = 'inquiry' | 'quoting' | 'quoted' | 'ordered' | 'in_production' | 'delivered' | 'closed' | 'lost';

export interface JobRecord {
  id: string;               // DOP-YYYY-NNN (parent key of the record chain)
  customer: string;         // customer name is the customer's business, not a confidential partner name
  title: string;
  stage: JobStage;
  owner: string;            // named person responsible
  createdAt: string;
  updatedAt: string;
  /** Child records of the chain: RFQ_OUT (to suppliers), CN (quote), PO (order). */
  children: { type: 'RFQ_OUT' | 'CN' | 'PO'; id: string; status: string; counterparty?: string }[];
  /** Where to order what when the PO comes: supplier per package, decided at quoting. */
  sourcingPlan?: { package: string; supplierRef: string; status: 'open' | 'quoted' | 'chosen' }[];
}

export interface MailProvider {
  searchMail(query: string, opts?: { mailbox?: string; limit?: number }): Promise<MailMessage[]>;
  getMessage(id: string): Promise<MailMessage | null>;
}

export interface FilesProvider {
  searchFiles(query: string, opts?: { library?: string; jobId?: string; limit?: number }): Promise<FileEntry[]>;
}

export interface RecordsProvider {
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(opts?: { stage?: JobStage; limit?: number }): Promise<JobRecord[]>;
}

export interface MemoryProvider {
  appendLedger(line: { when: string; from: string; to: string; task: string; status: 'DONE' | 'OPEN' | 'PROBLEM' | 'STOP'; evidence: string }): Promise<string>;
  readLedgerTail(n?: number): Promise<string[]>;
  readStatePage(): Promise<string>;
}

export interface Providers {
  mail: MailProvider;
  files: FilesProvider;
  records: RecordsProvider;
  memory: MemoryProvider;
  /**
   * The only write path out of the company (transport.ts). MailProvider stays read-only; only the send record dispatcher
   * (send_dispatcher.ts) calls it, never a tool. The mock bundle carries FakeTransport; no real transport exists yet.
   */
  transport?: SendTransport;
}

/** Provider names as they appear in layers.yaml. */
export type ProviderName = 'mock' | 'm365' | 'google' | 'fabrix' | 'odoo' | 'github' | 'none';
