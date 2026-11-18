import { type AuditEvent, type CaseEvent, type CaseMeta, type CaseRecord, DomainError, type Task, type User } from '../domain/types';
import type { AuditPage, CaseChanges, Repository } from './repository';

/** In-process repository for local development and tests. Same semantics as DynamoRepository. */
export class MemoryRepository implements Repository {
  private cases = new Map<string, CaseMeta>();
  private events = new Map<string, CaseEvent[]>();
  private tasks = new Map<string, Map<string, Task>>();
  private users = new Map<string, User>();
  private audit: AuditEvent[] = [];

  async getCase(id: string): Promise<CaseRecord | null> {
    const meta = this.cases.get(id);
    if (!meta) return null;
    return structuredClone({
      meta,
      events: [...(this.events.get(id) ?? [])].sort((a, b) => a.at.localeCompare(b.at)),
      tasks: [...(this.tasks.get(id)?.values() ?? [])],
    });
  }

  async listCases(opts: { statuses: string[]; ownerId?: string }): Promise<CaseMeta[]> {
    return structuredClone([...this.cases.values()].filter((c) =>
      opts.statuses.includes(c.status) && (opts.ownerId === undefined || c.ownerId === opts.ownerId)));
  }

  async save(ch: CaseChanges): Promise<void> {
    if (ch.meta) {
      const current = this.cases.get(ch.meta.id);
      if (ch.expectedVersion === null && current) throw new DomainError('CONFLICT', `Case ${ch.meta.id} already exists`);
      if (typeof ch.expectedVersion === 'number' && current?.version !== ch.expectedVersion) {
        throw new DomainError('CONFLICT', `Case ${ch.meta.id} was changed by someone else; reload and try again`);
      }
      this.cases.set(ch.meta.id, structuredClone(ch.meta));
    }
    for (const e of ch.events ?? []) {
      const list = this.events.get(e.caseId) ?? [];
      list.push(structuredClone(e));
      this.events.set(e.caseId, list);
    }
    for (const t of ch.tasks ?? []) {
      const m = this.tasks.get(t.caseId) ?? new Map<string, Task>();
      m.set(t.id, structuredClone(t));
      this.tasks.set(t.caseId, m);
    }
  }

  async upsertUser(user: User): Promise<void> {
    this.users.set(user.id, { ...user });
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(Object.freeze(structuredClone(event)));
  }

  async listAudit(opts: { caseId?: string; limit: number; nextToken?: string | null }): Promise<AuditPage> {
    const all = this.audit
      .filter((e) => !opts.caseId || e.caseIds.includes(opts.caseId))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const start = opts.nextToken ? Number(opts.nextToken) : 0;
    const items = all.slice(start, start + opts.limit);
    return { items: structuredClone(items), nextToken: start + opts.limit < all.length ? String(start + opts.limit) : null };
  }
}
