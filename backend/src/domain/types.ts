// Core domain types. Every record in this system is synthetic; see src/seed/synthetic.ts.

export const STEPS = ['ENROLLMENT', 'BENEFITS_VERIFICATION', 'PRIOR_AUTHORIZATION', 'FIRST_FILL', 'ON_THERAPY'] as const;
export type Step = (typeof STEPS)[number];

export type CaseStatus = 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'DISCONTINUED';
export type SlaState = 'ON_TRACK' | 'AT_RISK' | 'STUCK';

export const ROLES = ['INTAKE_COORDINATOR', 'CASE_MANAGER', 'SUPERVISOR', 'COMPLIANCE_AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  name: string;
  role: Role;
}

export interface Patient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;  // YYYY-MM-DD
  memberId: string;
  phone: string;
}

export interface Prescriber {
  name: string;
  practice: string;
  phone: string;
}

/** The case record itself (one DynamoDB item). Events and tasks are separate items. */
export interface CaseMeta {
  id: string;
  patient: Patient;
  therapy: string;
  payer: string;
  prescriber: Prescriber;
  step: Step;
  stepEnteredAt: string;  // ISO timestamp
  status: CaseStatus;
  ownerId: string | null;
  lastRefillCheckInAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Incremented on every write; used for optimistic concurrency. */
  version: number;
  synthetic: true;
}

export type EventType =
  | 'CREATED' | 'STEP_ADVANCED' | 'STATUS_CHANGED' | 'OWNER_CHANGED' | 'NOTE' | 'CALL'
  | 'TASK_CREATED' | 'TASK_COMPLETED' | 'REFILL_CHECKIN' | 'AI_DRAFT_ACCEPTED';

export interface CaseEvent {
  id: string;
  caseId: string;
  at: string;
  actorId: string;
  type: EventType;
  summary: string;
}

export type TaskStatus = 'OPEN' | 'DONE';
export type TaskSource = 'MANUAL' | 'AI_DRAFT';

export interface Task {
  id: string;
  caseId: string;
  title: string;
  dueAt: string;
  assigneeId: string | null;
  status: TaskStatus;
  source: TaskSource;
  createdAt: string;
  completedAt: string | null;
}

export interface CaseRecord {
  meta: CaseMeta;
  events: CaseEvent[];
  tasks: Task[];
}

export type AuditAction =
  | 'LIST_CASES' | 'VIEW_CASE' | 'VIEW_DASHBOARD' | 'CREATE_CASE' | 'UPDATE_CASE' | 'ASSIGN_CASE'
  | 'ADD_TASK' | 'COMPLETE_TASK' | 'DRAFT_NEXT_ACTION' | 'ACCEPT_DRAFT' | 'VIEW_AUDIT_LOG';

/** Append-only access log entry: who touched which record, when, and whether it was allowed. */
export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  actorRole: Role;
  action: AuditAction;
  outcome: 'ALLOWED' | 'DENIED';
  caseIds: string[];
  /** Which protected fields were returned unmasked, or why access was denied. */
  detail: string;
}

export class DomainError extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID', message: string) {
    super(message);
  }
}
