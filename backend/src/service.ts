import { randomUUID } from 'node:crypto';
import { buildAgentContext, WITHHELD_FIELDS } from './agent/context';
import type { Drafter } from './agent/drafter';
import type { Repository } from './data/repository';
import { can, canDraft, canUpdateCase, canViewCase, canViewPhi, patientView, requirePermission, ROLE_PERMISSIONS } from './domain/rbac';
import {
  type AuditAction, type AuditEvent, type CaseEvent, type CaseMeta, type CaseRecord, type CaseStatus, DomainError,
  type EventType, type Patient, type Prescriber, type SlaState, type Step, STEPS, type Task, type User,
} from './domain/types';
import { assertCanAdvance, slaInfo, STEP_LABELS } from './domain/workflow';

export interface Deps {
  repo: Repository;
  drafter: Drafter;
  now?: () => Date;
}

const OPEN_STATUSES: CaseStatus[] = ['ACTIVE', 'ON_HOLD'];
const ALL_STATUSES: CaseStatus[] = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'DISCONTINUED'];
const DAY_MS = 86_400_000;

/** Event types whose free text may contain patient details; hidden from roles without PHI access. */
const FREE_TEXT_EVENTS: EventType[] = ['NOTE', 'CALL', 'REFILL_CHECKIN'];

export interface CaseFilter {
  scope?: 'MINE' | 'ALL';
  step?: Step;
  slaState?: SlaState;
  includeClosed?: boolean;
}

export interface CreateCaseInput {
  patient: Patient;
  therapy: string;
  payer: string;
  prescriber: Prescriber;
}

/**
 * Business operations. Each one authorizes the caller, does the work, and
 * writes an audit entry; denials are audited too. Reads are audited before
 * any data is returned, so a failed audit write fails the request.
 */
export class CaseService {
  private readonly now: () => Date;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- queries ----------

  async me(user: User) {
    await this.deps.repo.upsertUser(user);
    return { ...user, permissions: ROLE_PERMISSIONS[user.role] };
  }

  async users(user: User) {
    requirePermission(user, 'case:list');
    return (await this.deps.repo.listUsers()).filter((u) => u.role !== 'COMPLIANCE_AUDITOR');
  }

  async listCases(user: User, filter: CaseFilter = {}) {
    return this.audited(user, 'LIST_CASES', [], async () => {
      requirePermission(user, 'case:list');
      const statuses = filter.includeClosed ? ALL_STATUSES : OPEN_STATUSES;
      const metas = await this.deps.repo.listCases(filter.scope === 'MINE' ? { statuses, ownerId: user.id } : { statuses });
      const now = this.now();
      const visible = metas
        .filter((c) => canViewCase(user, c))
        .filter((c) => !filter.step || c.step === filter.step)
        .filter((c) => !filter.slaState || slaInfo(c, now).slaState === filter.slaState)
        .sort(byUrgency(now));
      const users = await this.userMap();
      return { result: visible.map((c) => this.caseView(user, { meta: c, events: [], tasks: [] }, users)), caseIds: visible.map((c) => c.id), detail: 'list view (no protected fields)' };
    });
  }

  async getCase(user: User, id: string) {
    const rec = await this.deps.repo.getCase(id);
    if (!rec) throw new DomainError('NOT_FOUND', `No case ${id}`);
    return this.audited(user, 'VIEW_CASE', [id], async () => {
      if (!canViewCase(user, rec.meta)) throw new DomainError('FORBIDDEN', 'You can only open cases you own or unassigned cases');
      const users = await this.userMap();
      return { result: this.caseView(user, rec, users), detail: canViewPhi(user, rec.meta) ? 'protected fields shown' : 'protected fields masked' };
    });
  }

  async dashboard(user: User) {
    return this.audited(user, 'VIEW_DASHBOARD', [], async () => {
      requirePermission(user, 'case:list');
      const now = this.now();
      const cases = (await this.deps.repo.listCases({ statuses: OPEN_STATUSES })).filter((c) => canViewCase(user, c));
      const steps = STEPS.map((step) => {
        const inStep = cases.filter((c) => c.step === step);
        const states = inStep.map((c) => slaInfo(c, now).slaState);
        return {
          step, label: STEP_LABELS[step], total: inStep.length,
          onTrack: states.filter((s) => s === 'ON_TRACK').length,
          atRisk: states.filter((s) => s === 'AT_RISK').length,
          stuck: states.filter((s) => s === 'STUCK').length,
          onHold: inStep.filter((c) => c.status === 'ON_HOLD').length,
        };
      });
      const stuck = cases.filter((c) => slaInfo(c, now).slaState === 'STUCK').sort(byUrgency(now));
      const users = await this.userMap();
      return {
        result: {
          generatedAt: now.toISOString(),
          totalOpen: cases.length,
          unassigned: cases.filter((c) => c.ownerId === null).length,
          steps,
          stuckCases: stuck.map((c) => this.caseView(user, { meta: c, events: [], tasks: [] }, users)),
        },
        caseIds: stuck.map((c) => c.id),
        detail: 'dashboard (no protected fields)',
      };
    });
  }

  async auditLog(user: User, opts: { caseId?: string | null; limit?: number | null; nextToken?: string | null }) {
    return this.audited(user, 'VIEW_AUDIT_LOG', opts.caseId ? [opts.caseId] : [], async () => {
      requirePermission(user, 'audit:view');
      const page = await this.deps.repo.listAudit({
        caseId: opts.caseId ?? undefined,
        limit: Math.min(200, Math.max(1, opts.limit ?? 50)),
        nextToken: opts.nextToken,
      });
      return { result: page, detail: opts.caseId ? `filtered to ${opts.caseId}` : 'all entries' };
    });
  }

  // ---------- mutations ----------

  async createCase(user: User, input: CreateCaseInput) {
    const id = `CASE-${randomUUID().slice(0, 6).toUpperCase()}`;
    return this.audited(user, 'CREATE_CASE', [id], async () => {
      requirePermission(user, 'case:create');
      validateCreate(input);
      const at = this.now().toISOString();
      const meta: CaseMeta = {
        id, patient: input.patient, therapy: input.therapy.trim(), payer: input.payer.trim(), prescriber: input.prescriber,
        step: 'ENROLLMENT', stepEnteredAt: at, status: 'ACTIVE', ownerId: user.id, lastRefillCheckInAt: null,
        createdAt: at, updatedAt: at, version: 1, synthetic: true,
      };
      await this.deps.repo.save({ meta, expectedVersion: null, events: [this.event(id, user, 'CREATED', `Case opened by ${user.name}`, at)] });
      return { result: await this.reload(user, id), detail: 'case created' };
    });
  }

  async advanceStep(user: User, caseId: string, expectedVersion: number, note?: string | null) {
    return this.mutate(user, 'UPDATE_CASE', caseId, expectedVersion, (rec, at) => {
      const next = assertCanAdvance(rec.meta);
      const from = STEP_LABELS[rec.meta.step];
      return {
        meta: { ...rec.meta, step: next, stepEnteredAt: at, lastRefillCheckInAt: next === 'ON_THERAPY' ? at : rec.meta.lastRefillCheckInAt },
        events: [this.event(caseId, user, 'STEP_ADVANCED', `${from} → ${STEP_LABELS[next]}${note?.trim() ? `: ${note.trim()}` : ''}`, at)],
        detail: `advanced to ${next}`,
      };
    });
  }

  async setStatus(user: User, caseId: string, expectedVersion: number, status: CaseStatus, reason: string) {
    if (!reason?.trim()) throw new DomainError('INVALID', 'A reason is required to change case status');
    return this.mutate(user, 'UPDATE_CASE', caseId, expectedVersion, (rec, at) => {
      if (rec.meta.status === status) throw new DomainError('INVALID', `Case is already ${status}`);
      // Resuming restarts the step clock so time on hold doesn't count against the SLA.
      const resuming = rec.meta.status === 'ON_HOLD' && status === 'ACTIVE';
      return {
        meta: { ...rec.meta, status, stepEnteredAt: resuming ? at : rec.meta.stepEnteredAt },
        events: [this.event(caseId, user, 'STATUS_CHANGED', `Status ${rec.meta.status} → ${status}: ${reason.trim()}`, at)],
        detail: `status ${status}`,
      };
    });
  }

  async addNote(user: User, caseId: string, kind: 'NOTE' | 'CALL', text: string) {
    if (!text?.trim()) throw new DomainError('INVALID', 'Note text is required');
    return this.mutate(user, 'UPDATE_CASE', caseId, null, (rec, at) => ({
      meta: rec.meta,
      events: [this.event(caseId, user, kind, text.trim().slice(0, 2000), at)],
      detail: kind === 'CALL' ? 'call logged' : 'note added',
    }));
  }

  async recordRefillCheckIn(user: User, caseId: string, note: string) {
    return this.mutate(user, 'UPDATE_CASE', caseId, null, (rec, at) => {
      if (rec.meta.step !== 'ON_THERAPY') throw new DomainError('INVALID', 'Refill check-ins apply only to cases on therapy');
      return {
        meta: { ...rec.meta, lastRefillCheckInAt: at },
        events: [this.event(caseId, user, 'REFILL_CHECKIN', `Refill check-in${note?.trim() ? `: ${note.trim()}` : ''}`, at)],
        detail: 'refill check-in',
      };
    });
  }

  async assignCase(user: User, caseId: string, ownerId: string | null) {
    const users = await this.userMap();
    if (ownerId && !users.has(ownerId)) throw new DomainError('INVALID', `Unknown staff member ${ownerId}`);
    return this.mutate(user, 'ASSIGN_CASE', caseId, null, (rec, at) => {
      const selfClaim = ownerId === user.id && rec.meta.ownerId === null && can(user, 'case:update:own');
      if (!can(user, 'case:assign') && !selfClaim) throw new DomainError('FORBIDDEN', 'Only supervisors can reassign cases');
      const name = (id: string | null) => (id ? users.get(id)?.name ?? id : 'unassigned');
      return {
        meta: { ...rec.meta, ownerId },
        events: [this.event(caseId, user, 'OWNER_CHANGED', `Owner ${name(rec.meta.ownerId)} → ${name(ownerId)}`, at)],
        detail: `owner ${ownerId ?? 'none'}`,
      };
    }, { skipUpdateCheck: true });
  }

  async addTask(user: User, caseId: string, title: string, dueAt: string, assigneeId?: string | null) {
    if (!title?.trim()) throw new DomainError('INVALID', 'Task title is required');
    if (Number.isNaN(Date.parse(dueAt))) throw new DomainError('INVALID', 'dueAt must be an ISO date');
    return this.mutate(user, 'ADD_TASK', caseId, null, (rec, at) => {
      const task = this.task(caseId, title.trim(), new Date(dueAt).toISOString(), assigneeId ?? rec.meta.ownerId, 'MANUAL', at);
      return { meta: rec.meta, tasks: [task], events: [this.event(caseId, user, 'TASK_CREATED', `Task: ${task.title}`, at)], detail: 'task added' };
    });
  }

  async completeTask(user: User, caseId: string, taskId: string) {
    return this.mutate(user, 'COMPLETE_TASK', caseId, null, (rec, at) => {
      const t = rec.tasks.find((x) => x.id === taskId);
      if (!t) throw new DomainError('NOT_FOUND', `No task ${taskId} on ${caseId}`);
      if (t.status === 'DONE') throw new DomainError('INVALID', 'Task is already done');
      return {
        meta: rec.meta,
        tasks: [{ ...t, status: 'DONE', completedAt: at }],
        events: [this.event(caseId, user, 'TASK_COMPLETED', `Completed: ${t.title}`, at)],
        detail: 'task completed',
      };
    });
  }

  /** Drafts a next action with the AI agent. Nothing is saved until a person accepts it. */
  async draftNextAction(user: User, caseId: string) {
    const rec = await this.deps.repo.getCase(caseId);
    if (!rec) throw new DomainError('NOT_FOUND', `No case ${caseId}`);
    let resultDetail = '';
    const out = await this.audited(user, 'DRAFT_NEXT_ACTION', [caseId], async () => {
      if (!canDraft(user, rec.meta)) throw new DomainError('FORBIDDEN', 'You can only draft actions on cases you work');
      const ctx = buildAgentContext(rec, this.now());
      const r = await this.deps.drafter.draft(ctx);
      resultDetail = `generatedBy=${r.generatedBy}${r.fallbackReason ? ` (fallback: ${r.fallbackReason})` : ''}; withheld ${WITHHELD_FIELDS.length} identifier fields`;
      return {
        result: { caseId, ...r.draft, generatedBy: r.generatedBy, fallbackReason: r.fallbackReason, withheldFields: [...WITHHELD_FIELDS] },
        detail: () => resultDetail,
      };
    });
    return out;
  }

  /** A person accepted a draft: it becomes a task, attributed to the AI draft in the timeline. */
  async acceptDraft(user: User, caseId: string, title: string, dueInDays: number, rationale?: string | null) {
    if (!title?.trim()) throw new DomainError('INVALID', 'Task title is required');
    return this.mutate(user, 'ACCEPT_DRAFT', caseId, null, (rec, at) => {
      if (!canDraft(user, rec.meta)) throw new DomainError('FORBIDDEN', 'You can only accept drafts on cases you work');
      const due = new Date(new Date(at).getTime() + Math.min(14, Math.max(0, dueInDays)) * DAY_MS).toISOString();
      const task = this.task(caseId, title.trim().slice(0, 120), due, rec.meta.ownerId, 'AI_DRAFT', at);
      return {
        meta: rec.meta,
        tasks: [task],
        events: [this.event(caseId, user, 'AI_DRAFT_ACCEPTED',
          `Accepted AI-drafted next action: ${task.title}${rationale?.trim() ? ` (${rationale.trim().slice(0, 300)})` : ''}`, at)],
        detail: 'AI draft accepted as task',
      };
    });
  }

  // ---------- helpers ----------

  /**
   * Read-modify-write on one case with an optimistic version check.
   * `expectedVersion` is the version the user was looking at (null: use the
   * version read here, which still catches concurrent writers).
   */
  private async mutate(
    user: User, action: AuditAction, caseId: string, expectedVersion: number | null,
    change: (rec: CaseRecord, at: string) => { meta: CaseMeta; events?: CaseEvent[]; tasks?: Task[]; detail: string },
    opts: { skipUpdateCheck?: boolean } = {},
  ) {
    const rec = await this.deps.repo.getCase(caseId);
    if (!rec) throw new DomainError('NOT_FOUND', `No case ${caseId}`);
    return this.audited(user, action, [caseId], async () => {
      if (!opts.skipUpdateCheck && !canUpdateCase(user, rec.meta)) {
        throw new DomainError('FORBIDDEN', 'You can only change cases you own or unassigned cases');
      }
      if (expectedVersion !== null && rec.meta.version !== expectedVersion) {
        throw new DomainError('CONFLICT', `Case ${caseId} was changed by someone else; reload and try again`);
      }
      const at = this.now().toISOString();
      const c = change(rec, at);
      await this.deps.repo.save({
        meta: { ...c.meta, updatedAt: at, version: rec.meta.version + 1 },
        expectedVersion: rec.meta.version,
        events: c.events,
        tasks: c.tasks,
      });
      return { result: await this.reload(user, caseId), detail: c.detail };
    });
  }

  private async audited<T>(
    user: User, action: AuditAction, caseIds: string[],
    fn: () => Promise<{ result: T; caseIds?: string[]; detail: string | (() => string) }>,
  ): Promise<T> {
    let out: Awaited<ReturnType<typeof fn>>;
    try {
      out = await fn();
    } catch (err) {
      if (err instanceof DomainError && err.code === 'FORBIDDEN') {
        await this.writeAudit(user, action, caseIds, 'DENIED', err.message);
      }
      throw err;
    }
    const detail = typeof out.detail === 'function' ? out.detail() : out.detail;
    await this.writeAudit(user, action, out.caseIds ?? caseIds, 'ALLOWED', detail);
    return out.result;
  }

  private writeAudit(user: User, action: AuditAction, caseIds: string[], outcome: AuditEvent['outcome'], detail: string) {
    return this.deps.repo.appendAudit({
      id: randomUUID(), at: this.now().toISOString(), actorId: user.id, actorName: user.name, actorRole: user.role,
      action, outcome, caseIds, detail,
    });
  }

  private async reload(user: User, id: string) {
    const rec = await this.deps.repo.getCase(id);
    if (!rec) throw new DomainError('NOT_FOUND', `No case ${id}`);
    return this.caseView(user, rec, await this.userMap());
  }

  private async userMap() {
    return new Map((await this.deps.repo.listUsers()).map((u) => [u.id, u]));
  }

  private event(caseId: string, user: User, type: EventType, summary: string, at: string): CaseEvent {
    return { id: randomUUID(), caseId, at, actorId: user.id, type, summary };
  }

  private task(caseId: string, title: string, dueAt: string, assigneeId: string | null, source: Task['source'], at: string): Task {
    return { id: randomUUID(), caseId, title, dueAt, assigneeId, status: 'OPEN', source, createdAt: at, completedAt: null };
  }

  /** Shapes a case for one viewer: masks what their role may not see. */
  caseView(user: User, rec: CaseRecord, users: Map<string, User>) {
    const c = rec.meta;
    const now = this.now();
    const phi = canViewPhi(user, c);
    const ref = (id: string | null) => (id ? { id, name: users.get(id)?.name ?? 'Former staff', role: users.get(id)?.role ?? null } : null);
    return {
      id: c.id,
      patient: patientView(user, c),
      therapy: c.therapy,
      payer: c.payer,
      prescriber: { name: c.prescriber.name, practice: c.prescriber.practice, phone: can(user, 'patient:name') ? c.prescriber.phone : null },
      step: c.step,
      stepLabel: STEP_LABELS[c.step],
      status: c.status,
      owner: ref(c.ownerId),
      stepEnteredAt: c.stepEnteredAt,
      ...slaInfo(c, now),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      version: c.version,
      synthetic: c.synthetic,
      canEdit: canUpdateCase(user, c),
      canDraft: canDraft(user, c),
      events: rec.events
        .slice()
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((e) => ({
          id: e.id, at: e.at, type: e.type, actor: ref(e.actorId),
          summary: !phi && FREE_TEXT_EVENTS.includes(e.type) ? '[free text hidden: protected fields not visible to your role]' : e.summary,
        })),
      tasks: rec.tasks
        .slice()
        .sort((a, b) => (a.status === b.status ? a.dueAt.localeCompare(b.dueAt) : a.status === 'OPEN' ? -1 : 1))
        .map((t) => ({ ...t, assignee: ref(t.assigneeId), overdue: t.status === 'OPEN' && new Date(t.dueAt) < now })),
    };
  }
}

const SLA_ORDER: Record<SlaState, number> = { STUCK: 0, AT_RISK: 1, ON_TRACK: 2 };

function byUrgency(now: Date) {
  return (a: CaseMeta, b: CaseMeta) => {
    const sa = slaInfo(a, now), sb = slaInfo(b, now);
    return SLA_ORDER[sa.slaState] - SLA_ORDER[sb.slaState] || sb.daysInStep / sb.slaDays - sa.daysInStep / sa.slaDays || a.id.localeCompare(b.id);
  };
}

function validateCreate(i: CreateCaseInput) {
  const required = [i.patient?.firstName, i.patient?.lastName, i.patient?.dateOfBirth, i.patient?.memberId, i.therapy, i.payer, i.prescriber?.name];
  if (required.some((v) => !v?.trim())) throw new DomainError('INVALID', 'Missing required case fields');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.patient.dateOfBirth)) throw new DomainError('INVALID', 'dateOfBirth must be YYYY-MM-DD');
  // Guardrail for a synthetic-only system: member IDs must use the synthetic prefix.
  if (!i.patient.memberId.startsWith('SYN-')) throw new DomainError('INVALID', 'Synthetic data only: member IDs must start with SYN-');
}
