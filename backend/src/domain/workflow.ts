import { type CaseMeta, DomainError, type SlaState, type Step, STEPS } from './types';

const DAY_MS = 86_400_000;

/** Days a case may sit in each step before it counts as stuck. */
export const SLA_DAYS: Record<Step, number> = {
  ENROLLMENT: 2,
  BENEFITS_VERIFICATION: 3,
  PRIOR_AUTHORIZATION: 7,
  FIRST_FILL: 3,
  ON_THERAPY: 30,  // refill check-in interval
};

/** Fraction of the SLA after which a case is flagged at risk. */
export const AT_RISK_FRACTION = 0.75;

export const STEP_LABELS: Record<Step, string> = {
  ENROLLMENT: 'Enrollment',
  BENEFITS_VERIFICATION: 'Benefits verification',
  PRIOR_AUTHORIZATION: 'Prior authorization',
  FIRST_FILL: 'First fill',
  ON_THERAPY: 'On therapy (refill check-ins)',
};

export function daysBetween(fromIso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(fromIso).getTime()) / DAY_MS);
}

/**
 * When the SLA clock for the current step started. On therapy, the clock
 * restarts at each refill check-in.
 */
export function clockStart(c: CaseMeta): string {
  if (c.step === 'ON_THERAPY' && c.lastRefillCheckInAt && c.lastRefillCheckInAt > c.stepEnteredAt) {
    return c.lastRefillCheckInAt;
  }
  return c.stepEnteredAt;
}

export interface SlaInfo {
  daysInStep: number;
  slaDays: number;
  slaState: SlaState;
  /** For cases on therapy: when the next refill check-in is due. */
  nextRefillDue: string | null;
}

export function slaInfo(c: CaseMeta, now: Date): SlaInfo {
  const slaDays = SLA_DAYS[c.step];
  const start = clockStart(c);
  const days = daysBetween(start, now);
  let slaState: SlaState = 'ON_TRACK';
  // The SLA only runs while the case is active; on-hold and closed cases are not flagged.
  if (c.status === 'ACTIVE') {
    if (days > slaDays) slaState = 'STUCK';
    else if (days >= slaDays * AT_RISK_FRACTION) slaState = 'AT_RISK';
  }
  return {
    daysInStep: Math.floor(days),
    slaDays,
    slaState,
    nextRefillDue: c.step === 'ON_THERAPY' ? new Date(new Date(start).getTime() + slaDays * DAY_MS).toISOString() : null,
  };
}

export function nextStep(step: Step): Step | null {
  const i = STEPS.indexOf(step);
  return i < STEPS.length - 1 ? STEPS[i + 1] : null;
}

/** Steps advance one at a time, and only on active cases. */
export function assertCanAdvance(c: CaseMeta): Step {
  if (c.status !== 'ACTIVE') throw new DomainError('INVALID', `Case ${c.id} is ${c.status}; only active cases can advance`);
  const next = nextStep(c.step);
  if (!next) throw new DomainError('INVALID', `Case ${c.id} is already on therapy; record refill check-ins instead`);
  return next;
}
