/**
 * Layer 6, human gates: the approval queue.
 * A worker that receives "ask" from the policy files a request here and stops. A person decides once.
 * Storage: append-only JSONL (one event per line: request or decision); state is rebuilt from events,
 * so a crash between write and read cannot lose or double a decision.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  requestedBy: string;          // worker or agent id
  category: string;             // policy ActionCategory
  summary: string;              // one line a person reads
  payload: Record<string, unknown>;
  reasons: string[];            // why the policy said ask
}

export interface ApprovalDecision {
  id: string;
  decidedAt: string;
  decidedBy: string;            // a named person
  decision: Exclude<ApprovalStatus, 'pending'>;
  note?: string;
}

type Event = { type: 'request'; data: ApprovalRequest } | { type: 'decision'; data: ApprovalDecision };

export interface ApprovalView extends ApprovalRequest {
  status: ApprovalStatus;
  decision?: ApprovalDecision;
}

export class ApprovalQueue {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  private async events(): Promise<Event[]> {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Event);
  }

  private async append(ev: Event): Promise<void> {
    await appendFile(this.path, JSON.stringify(ev) + '\n', 'utf8');
  }

  async request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalRequest> {
    if (!input.summary.trim()) throw new Error('summary is required');
    const req: ApprovalRequest = { id: randomUUID(), createdAt: this.now().toISOString(), ...input };
    await this.append({ type: 'request', data: req });
    return req;
  }

  async list(status?: ApprovalStatus): Promise<ApprovalView[]> {
    const byId = new Map<string, ApprovalView>();
    for (const ev of await this.events()) {
      if (ev.type === 'request') byId.set(ev.data.id, { ...ev.data, status: 'pending' });
      else {
        const v = byId.get(ev.data.id);
        if (v && v.status === 'pending') {
          v.status = ev.data.decision;
          v.decision = ev.data;
        }
      }
    }
    const all = [...byId.values()];
    return status ? all.filter((v) => v.status === status) : all;
  }

  /** One decision per request. A second decision is rejected, never applied. */
  async decide(id: string, decision: 'approved' | 'rejected', decidedBy: string, note?: string): Promise<ApprovalView> {
    if (!decidedBy.trim()) throw new Error('decidedBy must name a person');
    const current = (await this.list()).find((v) => v.id === id);
    if (!current) throw new Error(`unknown approval ${id}`);
    if (current.status !== 'pending') throw new Error(`approval ${id} already ${current.status}`);
    const d: ApprovalDecision = { id, decidedAt: this.now().toISOString(), decidedBy, decision, note };
    await this.append({ type: 'decision', data: d });
    return { ...current, status: decision, decision: d };
  }
}
