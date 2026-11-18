// Synthetic data only. Names are random combinations from short lists, member IDs
// use the SYN- prefix, phone numbers are in the 555-0100..0199 range reserved for
// fiction, and therapies are made-up codes. Nothing here describes a real person.

import type { CaseEvent, CaseMeta, CaseRecord, CaseStatus, EventType, Step, Task, User } from '../domain/types';
import { STEPS } from '../domain/types';
import { SLA_DAYS } from '../domain/workflow';

export const STAFF: User[] = [
  { id: 'u-coord-1', name: 'Avery Lin', role: 'INTAKE_COORDINATOR' },
  { id: 'u-cm-1', name: 'Jordan Patel', role: 'CASE_MANAGER' },
  { id: 'u-cm-2', name: 'Sam Rivera', role: 'CASE_MANAGER' },
  { id: 'u-sup-1', name: 'Morgan Lee', role: 'SUPERVISOR' },
  { id: 'u-aud-1', name: 'Riley Chen', role: 'COMPLIANCE_AUDITOR' },
];

const FIRST = ['Alex', 'Blair', 'Casey', 'Dana', 'Elliot', 'Frances', 'Gale', 'Harper', 'Indra', 'Jules', 'Kai', 'Lane',
               'Marlo', 'Noor', 'Oakley', 'Peyton', 'Quinn', 'Reese', 'Sasha', 'Tatum', 'Umi', 'Vale', 'Wren', 'Yael'];
const LAST = ['Ashdown', 'Brightwater', 'Coldfield', 'Dunmore', 'Eastwick', 'Fairbourne', 'Greystone', 'Hollowell',
              'Ironwood', 'Juniper', 'Kestrel', 'Larkspur', 'Marlowe', 'Northcott', 'Oakhurst', 'Pembrook', 'Quillon',
              'Redfern', 'Stonebridge', 'Thornbury', 'Underhill', 'Vexley', 'Westbrook', 'Yarrow'];
const THERAPIES = ['ZX-101 autoinjector', 'ZX-204 infusion', 'QV-330 tablets', 'LM-512 prefilled syringe', 'RT-077 capsules'];
const PAYERS = ['Bluefield Mutual', 'Cedarline Health', 'Summitcrest Advantage', 'Harborview State Plan'];
const PRESCRIBERS = [
  { name: 'Dr. Imogen Halvorsen', practice: 'Lakeside Rheumatology' },
  { name: 'Dr. Tobias Quarrie', practice: 'Northgate Neurology Associates' },
  { name: 'Dr. Priya Vellacott', practice: 'Riverside Dermatology Group' },
  { name: 'Dr. Mateo Ellsworth', practice: 'Westfield Gastroenterology' },
];

const DAY_MS = 86_400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Template { type: EventType; text: string }

/** Plausible history for completing each step. {payer}, {prescriber} etc. are filled per case. */
const STEP_HISTORY: Record<Step, Template[]> = {
  ENROLLMENT: [
    { type: 'NOTE', text: 'Referral received from {practice}' },
    { type: 'CALL', text: 'Welcome call with {first}; confirmed best callback number {phone}' },
    { type: 'NOTE', text: 'Enrollment form and consent received' },
  ],
  BENEFITS_VERIFICATION: [
    { type: 'CALL', text: 'Called {payer} provider line; reference #SYN-{ref}' },
    { type: 'NOTE', text: '{payer} requires prior authorization for {therapy}; specialty pharmacy is in network' },
  ],
  PRIOR_AUTHORIZATION: [
    { type: 'NOTE', text: 'PA submitted to {payer} through the payer portal' },
    { type: 'NOTE', text: '{payer} requested recent chart notes and prior therapy history' },
    { type: 'CALL', text: "Called {prescriber}'s office at {rxphone}; office manager will fax chart notes" },
    { type: 'NOTE', text: 'Chart notes received and uploaded to the PA request' },
    { type: 'NOTE', text: 'PA approved by {payer}; authorization valid for 12 months' },
  ],
  FIRST_FILL: [
    { type: 'NOTE', text: 'Prescription transferred to specialty pharmacy' },
    { type: 'CALL', text: 'Scheduled first shipment with {first} {last}; delivery confirmed for a weekday' },
    { type: 'NOTE', text: 'First fill shipped' },
  ],
  ON_THERAPY: [
    { type: 'REFILL_CHECKIN', text: 'Refill check-in: no missed doses reported; next shipment scheduled' },
  ],
};

/** Events that happen while a case is still sitting in a step (not yet complete). */
const IN_PROGRESS: Record<Step, Template[]> = {
  ENROLLMENT: [{ type: 'NOTE', text: 'Referral received from {practice}' }, { type: 'CALL', text: 'Left voicemail for {first} at {phone} to complete enrollment' }],
  BENEFITS_VERIFICATION: [{ type: 'CALL', text: 'Called {payer} provider line; on hold 40 minutes, call dropped' }],
  PRIOR_AUTHORIZATION: [
    { type: 'NOTE', text: 'PA submitted to {payer} through the payer portal' },
    { type: 'NOTE', text: '{payer} requested recent chart notes and prior therapy history' },
    { type: 'CALL', text: "Called {prescriber}'s office at {rxphone}; left voicemail requesting chart notes" },
  ],
  FIRST_FILL: [{ type: 'NOTE', text: 'Prescription transferred to specialty pharmacy' }, { type: 'CALL', text: 'Tried to reach {first} to schedule delivery; no answer' }],
  ON_THERAPY: [],
};

export function syntheticData(now: Date, count = 48, seed = 20261116): { staff: User[]; cases: CaseRecord[] } {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const cases: CaseRecord[] = [];
  const usedNames = new Set<string>();

  for (let n = 0; n < count; n++) {
    const id = `CASE-${String(1001 + n)}`;
    let first: string, last: string;
    do { first = pick(FIRST); last = pick(LAST); } while (usedNames.has(first + last));
    usedNames.add(first + last);
    const rx = pick(PRESCRIBERS);
    const payer = pick(PAYERS);
    const therapy = pick(THERAPIES);
    const phone = `555-01${String(Math.floor(r() * 100)).padStart(2, '0')}`;
    const rxphone = `555-01${String(Math.floor(r() * 100)).padStart(2, '0')}`;
    const fill = (t: string) => t
      .replaceAll('{first}', first).replaceAll('{last}', last).replaceAll('{phone}', phone).replaceAll('{rxphone}', rxphone)
      .replaceAll('{payer}', payer).replaceAll('{therapy}', therapy).replaceAll('{prescriber}', rx.name)
      .replaceAll('{practice}', rx.practice).replaceAll('{ref}', String(100000 + Math.floor(r() * 899999)));

    // Weight toward the middle of the pipeline, where cases tend to pile up.
    const stepIndex = Math.min(4, Math.floor(Math.pow(r(), 0.9) * 5));
    const step = STEPS[stepIndex];
    const sla = SLA_DAYS[step];
    const roll = r();
    // ~30% stuck, ~20% at risk, rest on track.
    const daysInStep = roll < 0.3 ? sla + 1 + r() * sla * 0.8 : roll < 0.5 ? sla * (0.76 + r() * 0.22) : r() * sla * 0.7;
    const stepEnteredAt = new Date(now.getTime() - daysInStep * DAY_MS);

    // Walk back through the completed steps to build a timeline.
    const events: CaseEvent[] = [];
    let cursor = stepEnteredAt.getTime();
    const completed: { step: Step; start: number; end: number }[] = [];
    for (let s = stepIndex - 1; s >= 0; s--) {
      const len = (0.4 + r() * 0.8) * SLA_DAYS[STEPS[s]] * DAY_MS;
      completed.unshift({ step: STEPS[s], start: cursor - len, end: cursor });
      cursor -= len;
    }
    const createdAt = new Date(cursor);
    const owner = r() < 0.08 ? null : stepIndex <= 1 ? (r() < 0.7 ? 'u-coord-1' : pick(['u-cm-1', 'u-cm-2'])) : pick(['u-cm-1', 'u-cm-2']);
    const ev = (at: number, type: EventType, summary: string, actorId = owner ?? 'u-coord-1') =>
      events.push({ id: `${id}-E${events.length + 1}`, caseId: id, at: new Date(at).toISOString(), actorId, type, summary });

    ev(cursor, 'CREATED', 'Case opened from referral', 'u-coord-1');
    for (const c of completed) {
      const tpl = STEP_HISTORY[c.step];
      tpl.forEach((t, i) => ev(c.start + ((i + 1) / (tpl.length + 1)) * (c.end - c.start), t.type, fill(t.text)));
      const next = STEPS[STEPS.indexOf(c.step) + 1];
      ev(c.end, 'STEP_ADVANCED', `${label(c.step)} → ${label(next)}`);
    }
    const inProg = IN_PROGRESS[step];
    const shown = Math.min(inProg.length, Math.ceil(r() * inProg.length + (daysInStep > sla ? 1 : 0)));
    inProg.slice(0, shown).forEach((t, i) =>
      ev(stepEnteredAt.getTime() + ((i + 1) / (shown + 1)) * daysInStep * DAY_MS * 0.6, t.type, fill(t.text)));

    const statusRoll = r();
    const status: CaseStatus = statusRoll < 0.06 ? 'ON_HOLD' : statusRoll < 0.1 && step === 'ON_THERAPY' ? 'COMPLETED' : 'ACTIVE';
    if (status === 'ON_HOLD') ev(now.getTime() - daysInStep * 0.3 * DAY_MS, 'STATUS_CHANGED', 'Status ACTIVE → ON_HOLD: patient traveling, asked to pause until they return');

    const tasks: Task[] = [];
    if (status === 'ACTIVE' && r() < 0.6) {
      const due = now.getTime() + (r() * 6 - 3) * DAY_MS;  // some overdue
      tasks.push({
        id: `${id}-T1`, caseId: id, title: TASK_TITLES[step], dueAt: new Date(due).toISOString(), assigneeId: owner,
        status: 'OPEN', source: 'MANUAL', createdAt: new Date(due - 3 * DAY_MS).toISOString(), completedAt: null,
      });
    }

    const meta: CaseMeta = {
      id,
      patient: {
        firstName: first, lastName: last,
        dateOfBirth: new Date(Date.UTC(1950 + Math.floor(r() * 55), Math.floor(r() * 12), 1 + Math.floor(r() * 28))).toISOString().slice(0, 10),
        memberId: `SYN-${String(Math.floor(r() * 1e8)).padStart(8, '0')}`,
        phone,
      },
      therapy, payer,
      prescriber: { ...rx, phone: rxphone },
      step, stepEnteredAt: stepEnteredAt.toISOString(), status, ownerId: owner,
      lastRefillCheckInAt: step === 'ON_THERAPY' ? stepEnteredAt.toISOString() : null,
      createdAt: createdAt.toISOString(), updatedAt: events[events.length - 1].at,
      version: events.length, synthetic: true,
    };
    cases.push({ meta, events, tasks });
  }
  return { staff: STAFF, cases };
}

const TASK_TITLES: Record<Step, string> = {
  ENROLLMENT: 'Collect signed consent form',
  BENEFITS_VERIFICATION: 'Verify benefits with payer',
  PRIOR_AUTHORIZATION: 'Follow up on PA documentation',
  FIRST_FILL: 'Confirm delivery date with patient',
  ON_THERAPY: 'Refill check-in call',
};

function label(s: Step): string {
  return { ENROLLMENT: 'Enrollment', BENEFITS_VERIFICATION: 'Benefits verification', PRIOR_AUTHORIZATION: 'Prior authorization',
           FIRST_FILL: 'First fill', ON_THERAPY: 'On therapy (refill check-ins)' }[s];
}
