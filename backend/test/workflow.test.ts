import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/types';
import { assertCanAdvance, slaInfo } from '../src/domain/workflow';
import { caseMeta, DAY, NOW } from './helpers';

const entered = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('SLA state', () => {
  it.each([
    ['ENROLLMENT', 1, 'ON_TRACK'], ['ENROLLMENT', 1.6, 'AT_RISK'], ['ENROLLMENT', 2.5, 'STUCK'],
    ['PRIOR_AUTHORIZATION', 5, 'ON_TRACK'], ['PRIOR_AUTHORIZATION', 6, 'AT_RISK'], ['PRIOR_AUTHORIZATION', 9, 'STUCK'],
    ['FIRST_FILL', 3.1, 'STUCK'],
  ] as const)('%s after %s days is %s', (step, days, want) => {
    expect(slaInfo(caseMeta({ step, stepEnteredAt: entered(days) }), NOW).slaState).toBe(want);
  });

  it('does not flag cases that are on hold or closed', () => {
    for (const status of ['ON_HOLD', 'COMPLETED', 'DISCONTINUED'] as const) {
      expect(slaInfo(caseMeta({ status, stepEnteredAt: entered(40) }), NOW).slaState).toBe('ON_TRACK');
    }
  });

  it('restarts the on-therapy clock at each refill check-in', () => {
    const c = caseMeta({ step: 'ON_THERAPY', stepEnteredAt: entered(90), lastRefillCheckInAt: entered(10) });
    const s = slaInfo(c, NOW);
    expect(s.daysInStep).toBe(10);
    expect(s.slaState).toBe('ON_TRACK');
    expect(s.nextRefillDue).toBe(new Date(NOW.getTime() + 20 * DAY).toISOString());
    expect(slaInfo({ ...c, lastRefillCheckInAt: entered(31) }, NOW).slaState).toBe('STUCK');
  });
});

describe('step transitions', () => {
  it('advances one step at a time', () => {
    expect(assertCanAdvance(caseMeta({ step: 'ENROLLMENT' }))).toBe('BENEFITS_VERIFICATION');
    expect(assertCanAdvance(caseMeta({ step: 'FIRST_FILL' }))).toBe('ON_THERAPY');
  });

  it('refuses to advance past on-therapy or while not active', () => {
    expect(() => assertCanAdvance(caseMeta({ step: 'ON_THERAPY' }))).toThrow(DomainError);
    expect(() => assertCanAdvance(caseMeta({ status: 'ON_HOLD' }))).toThrow(/only active cases/);
  });
});
