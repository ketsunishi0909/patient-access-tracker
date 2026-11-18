import { RulesDrafter, type Drafter } from '../src/agent/drafter';
import { MemoryRepository } from '../src/data/memory';
import type { CaseMeta, User } from '../src/domain/types';
import { STAFF, syntheticData } from '../src/seed/synthetic';
import { CaseService } from '../src/service';

export const NOW = new Date('2026-11-16T15:00:00Z');
export const DAY = 86_400_000;

export const user = (id: string): User => {
  const u = STAFF.find((s) => s.id === id);
  if (!u) throw new Error(`no staff ${id}`);
  return u;
};
export const coordinator = user('u-coord-1');
export const manager = user('u-cm-1');
export const manager2 = user('u-cm-2');
export const supervisor = user('u-sup-1');
export const auditor = user('u-aud-1');

export function caseMeta(over: Partial<CaseMeta> = {}): CaseMeta {
  return {
    id: 'CASE-T1',
    patient: { firstName: 'Wren', lastName: 'Ashdown', dateOfBirth: '1971-04-09', memberId: 'SYN-00112233', phone: '555-0142' },
    therapy: 'ZX-101 autoinjector', payer: 'Bluefield Mutual',
    prescriber: { name: 'Dr. Imogen Halvorsen', practice: 'Lakeside Rheumatology', phone: '555-0177' },
    step: 'PRIOR_AUTHORIZATION', stepEnteredAt: new Date(NOW.getTime() - 9 * DAY).toISOString(),
    status: 'ACTIVE', ownerId: manager.id, lastRefillCheckInAt: null,
    createdAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), updatedAt: NOW.toISOString(), version: 3, synthetic: true,
    ...over,
  };
}

/** A service over a fresh in-memory store with the seeded synthetic dataset. */
export async function seededService(drafter: Drafter = new RulesDrafter()) {
  const repo = new MemoryRepository();
  const data = syntheticData(NOW);
  for (const u of data.staff) await repo.upsertUser(u);
  for (const c of data.cases) await repo.save({ meta: c.meta, expectedVersion: null, events: c.events, tasks: c.tasks });
  return { repo, data, svc: new CaseService({ repo, drafter, now: () => NOW }) };
}

/** A service with exactly the given cases. */
export async function serviceWith(metas: CaseMeta[], drafter: Drafter = new RulesDrafter()) {
  const repo = new MemoryRepository();
  for (const u of STAFF) await repo.upsertUser(u);
  for (const m of metas) await repo.save({ meta: m, expectedVersion: null });
  return { repo, svc: new CaseService({ repo, drafter, now: () => NOW }) };
}
