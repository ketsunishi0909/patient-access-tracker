import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/types';
import { auditor, caseMeta, coordinator, manager, manager2, seededService, serviceWith, supervisor } from './helpers';

describe('role-based access', () => {
  it('lets a case manager see protected fields only on cases they own', async () => {
    const { svc } = await serviceWith([caseMeta({ id: 'CASE-A', ownerId: manager.id }), caseMeta({ id: 'CASE-B', ownerId: manager2.id })]);
    const own = await svc.getCase(manager, 'CASE-A');
    expect(own.patient).toMatchObject({ displayName: 'Wren Ashdown', dateOfBirth: '1971-04-09', memberId: 'SYN-00112233', masked: false });
    const other = await svc.getCase(manager, 'CASE-B');
    expect(other.patient).toMatchObject({ displayName: 'Wren Ashdown', dateOfBirth: null, phone: null, memberId: '•••233', masked: true });
    expect(other.canEdit).toBe(false);
  });

  it('keeps intake coordinators to their own and unassigned cases', async () => {
    const { svc } = await serviceWith([
      caseMeta({ id: 'CASE-MINE', ownerId: coordinator.id }),
      caseMeta({ id: 'CASE-FREE', ownerId: null }),
      caseMeta({ id: 'CASE-THEIRS', ownerId: manager.id }),
    ]);
    const ids = (await svc.listCases(coordinator)).map((c) => c.id).sort();
    expect(ids).toEqual(['CASE-FREE', 'CASE-MINE']);
    await expect(svc.getCase(coordinator, 'CASE-THEIRS')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows the compliance auditor initials only, and hides free-text notes', async () => {
    const { svc } = await seededService();
    const withNotes = (await svc.listCases(supervisor)).find((c) => c.step === 'PRIOR_AUTHORIZATION')!;
    const view = await svc.getCase(auditor, withNotes.id);
    expect(view.patient.displayName).toMatch(/^[A-Z]\. [A-Z]\.$/);
    expect(view.patient).toMatchObject({ dateOfBirth: null, phone: null, masked: true });
    expect(view.prescriber.phone).toBeNull();
    const notes = view.events.filter((e) => e.type === 'CALL' || e.type === 'NOTE');
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.summary).toMatch(/hidden/);
  });

  it('gives the auditor no write or AI access', async () => {
    const { svc } = await serviceWith([caseMeta()]);
    await expect(svc.addNote(auditor, 'CASE-T1', 'NOTE', 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(svc.draftNextAction(auditor, 'CASE-T1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(svc.createCase(auditor, {
      patient: { firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', memberId: 'SYN-1', phone: '555-0100' },
      therapy: 't', payer: 'p', prescriber: { name: 'n', practice: 'p', phone: '555-0101' },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only lets supervisors reassign, but lets staff claim unassigned cases', async () => {
    const { svc } = await serviceWith([caseMeta({ id: 'CASE-A', ownerId: manager.id }), caseMeta({ id: 'CASE-FREE', ownerId: null })]);
    await expect(svc.assignCase(manager2, 'CASE-A', manager2.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await svc.assignCase(manager2, 'CASE-FREE', manager2.id)).owner?.id).toBe(manager2.id);
    expect((await svc.assignCase(supervisor, 'CASE-A', manager2.id)).owner?.id).toBe(manager2.id);
  });

  it('rejects non-synthetic member IDs', async () => {
    const { svc } = await serviceWith([]);
    await expect(svc.createCase(coordinator, {
      patient: { firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', memberId: 'XYZ123456', phone: '555-0100' },
      therapy: 't', payer: 'p', prescriber: { name: 'n', practice: 'p', phone: '555-0101' },
    })).rejects.toThrow(/Synthetic data only/);
  });
});

describe('audit log', () => {
  it('records who viewed which record, including whether protected fields were shown', async () => {
    const { svc, repo } = await serviceWith([caseMeta({ id: 'CASE-A', ownerId: manager.id })]);
    await svc.getCase(manager, 'CASE-A');
    await svc.getCase(manager2, 'CASE-A');
    const { items } = await repo.listAudit({ caseId: 'CASE-A', limit: 10 });
    expect(items.map((e) => [e.actorId, e.action, e.outcome, e.detail])).toEqual(expect.arrayContaining([
      [manager.id, 'VIEW_CASE', 'ALLOWED', 'protected fields shown'],
      [manager2.id, 'VIEW_CASE', 'ALLOWED', 'protected fields masked'],
    ]));
  });

  it('records denied attempts', async () => {
    const { svc, repo } = await serviceWith([caseMeta({ id: 'CASE-A', ownerId: manager.id })]);
    await expect(svc.getCase(coordinator, 'CASE-A')).rejects.toBeInstanceOf(DomainError);
    const { items } = await repo.listAudit({ caseId: 'CASE-A', limit: 10 });
    expect(items[0]).toMatchObject({ actorId: coordinator.id, action: 'VIEW_CASE', outcome: 'DENIED' });
  });

  it('records list views with every case shown, and audits reading the audit log itself', async () => {
    const { svc, repo } = await seededService();
    const listed = await svc.listCases(manager);
    await svc.auditLog(supervisor, {});
    const { items } = await repo.listAudit({ limit: 100 });
    const list = items.find((e) => e.action === 'LIST_CASES')!;
    expect(list.caseIds).toHaveLength(listed.length);
    expect(items.find((e) => e.action === 'VIEW_AUDIT_LOG')?.actorId).toBe(supervisor.id);
    await expect(svc.auditLog(manager, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails the read if the audit entry cannot be written', async () => {
    const { svc, repo } = await serviceWith([caseMeta()]);
    repo.appendAudit = async () => { throw new Error('audit store down'); };
    await expect(svc.getCase(manager, 'CASE-T1')).rejects.toThrow('audit store down');
  });
});

describe('concurrent edits', () => {
  it('rejects a step change made against a stale version', async () => {
    const { svc } = await serviceWith([caseMeta({ version: 3 })]);
    const updated = await svc.advanceStep(manager, 'CASE-T1', 3, 'PA approved');
    expect(updated).toMatchObject({ step: 'FIRST_FILL', version: 4, daysInStep: 0 });
    await expect(svc.advanceStep(manager, 'CASE-T1', 3)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('restarts the step clock when a case resumes from hold', async () => {
    const { svc } = await serviceWith([caseMeta({ status: 'ON_HOLD' })]);
    const resumed = await svc.setStatus(manager, 'CASE-T1', 3, 'ACTIVE', 'patient back from travel');
    expect(resumed).toMatchObject({ status: 'ACTIVE', daysInStep: 0, slaState: 'ON_TRACK' });
  });
});
