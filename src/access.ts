/**
 * Layer 5: scoped reads (A10 of the functional specification: a colleague who lacks access gets no restricted mail,
 * documents, search excerpts or AI responses). The server is configured with an access policy: per actor (the
 * configured caller of this server instance), the jobs it may read ('*' for every job of the tenant) and, optionally,
 * mailboxes whose unlinked messages it may read. Read tools return only what the actor may read; a record outside the
 * scope is absent, not redacted, so not even its existence leaks. An actor without an entry reads nothing.
 *
 * The actor is the server's configured caller. Authenticating that the person at the client is that actor is the
 * transport's job (one server process per person on stdio under the OS account; SSO in front of an HTTP server).
 */
import type { FileEntry, JobRecord, MailMessage } from './providers.js';

export interface ActorScope {
  /** Jobs this actor may read, or '*' for every job of the tenant. */
  jobs: '*' | string[];
  /** Mailboxes whose messages without a job link this actor may read (for example 'office@'). */
  mailboxes?: string[];
}

/** Actor id (the configured caller) -> scope. */
export type AccessPolicy = Record<string, ActorScope>;

export class AccessScopes {
  constructor(private readonly policy: AccessPolicy) {}

  scopeOf(actor: string): ActorScope | undefined {
    return Object.prototype.hasOwnProperty.call(this.policy, actor) ? this.policy[actor] : undefined;
  }

  /** The actor's scope, or an explicit error: an actor without an entry reads nothing. */
  require(actor: string): ActorScope {
    const scope = this.scopeOf(actor);
    if (!scope) throw new Error(`caller ${actor} has no access scope on this server: reads are refused`);
    return scope;
  }

  canReadJob(actor: string, jobId: string | undefined): boolean {
    const scope = this.scopeOf(actor);
    if (!scope || jobId === undefined) return false;
    return scope.jobs === '*' || scope.jobs.includes(jobId);
  }

  canReadMessage(actor: string, m: MailMessage): boolean {
    if (m.jobId !== undefined) return this.canReadJob(actor, m.jobId);
    return !!this.scopeOf(actor)?.mailboxes?.includes(m.mailbox);
  }

  canReadFile(actor: string, f: FileEntry): boolean {
    return this.canReadJob(actor, f.jobId);
  }

  messages(actor: string, list: MailMessage[]): MailMessage[] {
    this.require(actor);
    return list.filter((m) => this.canReadMessage(actor, m));
  }

  files(actor: string, list: FileEntry[]): FileEntry[] {
    this.require(actor);
    return list.filter((f) => this.canReadFile(actor, f));
  }

  jobs(actor: string, list: JobRecord[]): JobRecord[] {
    this.require(actor);
    return list.filter((j) => this.canReadJob(actor, j.id));
  }
}
