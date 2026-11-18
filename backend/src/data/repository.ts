import type { AuditEvent, CaseEvent, CaseMeta, CaseRecord, CaseStatus, Task, User } from '../domain/types';

export interface CaseChanges {
  /** New or updated case record. */
  meta?: CaseMeta;
  /** Version the stored record must have for the write to apply; null means "must not exist yet". */
  expectedVersion?: number | null;
  events?: CaseEvent[];
  /** New or updated tasks. */
  tasks?: Task[];
}

export interface AuditPage {
  items: AuditEvent[];
  nextToken: string | null;
}

export interface Repository {
  getCase(id: string): Promise<CaseRecord | null>;
  listCases(opts: { statuses: CaseStatus[]; ownerId?: string }): Promise<CaseMeta[]>;
  /** Applies all changes atomically. Throws DomainError('CONFLICT') if the version check fails. */
  save(changes: CaseChanges): Promise<void>;

  /** Staff seen by the system (in production, upserted from the Cognito identity on each request). */
  upsertUser(user: User): Promise<void>;
  listUsers(): Promise<User[]>;

  /** Audit log: append-only. There is deliberately no update or delete. */
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(opts: { caseId?: string; limit: number; nextToken?: string | null }): Promise<AuditPage>;
}
