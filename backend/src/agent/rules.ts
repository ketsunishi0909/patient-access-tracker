import type { AgentContext } from './context';
import type { Draft } from './schema';

/**
 * Deterministic next-action drafts from simple playbook rules. Used when no
 * model is configured, when the model call fails, or when the model declines.
 */
export function rulesDraft(ctx: AgentContext): Draft {
  const d = ctx.daysInStep;
  const late = ctx.slaState === 'STUCK';
  const urgency: Draft['urgency'] = late ? 'HIGH' : ctx.slaState === 'AT_RISK' ? 'MEDIUM' : 'LOW';
  const lastCall = [...ctx.history].reverse().find((h) => h.type === 'CALL');
  const situation = `${ctx.stepLabel} for ${d} day${d === 1 ? '' : 's'} (target ${ctx.slaDays}); ${ctx.slaState.replace('_', ' ').toLowerCase()}.`;
  const sinceCall = lastCall ? ` Last call was ${lastCall.daysAgo} day${lastCall.daysAgo === 1 ? '' : 's'} ago.` : ' No calls logged in this step.';

  if (ctx.status === 'ON_HOLD') {
    return {
      situation: `Case is on hold in ${ctx.stepLabel.toLowerCase()}.`,
      nextAction: 'Review the hold reason and confirm whether the case can resume.',
      rationale: 'On-hold cases are not on the SLA clock, so they need a scheduled review to avoid being forgotten.',
      urgency: 'LOW', contact: 'INTERNAL',
      suggestedTask: { title: 'Review on-hold case', dueInDays: 7 },
    };
  }
  if (!ctx.hasOwner) {
    return {
      situation, nextAction: 'Assign an owner to this case.', urgency,
      rationale: 'Unassigned cases have nobody accountable for the next step.', contact: 'INTERNAL',
      suggestedTask: { title: 'Assign case owner', dueInDays: 0 },
    };
  }
  switch (ctx.step) {
    case 'ENROLLMENT':
      return {
        situation, urgency, contact: 'PATIENT',
        nextAction: 'Confirm the enrollment form and consent are complete, and contact the patient for any missing items.',
        rationale: `Enrollment should finish within ${ctx.slaDays} days so benefits verification can start.${sinceCall}`,
        suggestedTask: { title: 'Complete enrollment intake', dueInDays: late ? 0 : 1 },
      };
    case 'BENEFITS_VERIFICATION':
      return {
        situation, urgency, contact: 'PAYER',
        nextAction: `Call ${ctx.payer} to confirm coverage, the specialty pharmacy network, and whether prior authorization is required.`,
        rationale: `Benefits verification is the input to the prior authorization decision.${sinceCall}`,
        suggestedTask: { title: `Verify benefits with ${ctx.payer}`, dueInDays: late ? 0 : 1 },
      };
    case 'PRIOR_AUTHORIZATION':
      return {
        situation: `Prior authorization pending ${d} day${d === 1 ? '' : 's'} (target ${ctx.slaDays}).`,
        urgency, contact: 'PRESCRIBER_OFFICE',
        nextAction: late
          ? "Follow up with the prescriber's office on the prior authorization status and any payer requests for more information."
          : 'Check the payer portal for a prior authorization decision.',
        rationale: `Prior authorization is past its ${ctx.slaDays}-day target, and missing clinical documentation is the most common cause of delay.${sinceCall}`,
        suggestedTask: { title: late ? 'Follow up on PA with prescriber office' : 'Check PA status', dueInDays: late ? 0 : 2 },
      };
    case 'FIRST_FILL':
      return {
        situation, urgency, contact: 'SPECIALTY_PHARMACY',
        nextAction: 'Confirm the specialty pharmacy has scheduled the first shipment and the patient has agreed a delivery date.',
        rationale: `The approval is in place; the remaining risk is scheduling.${sinceCall}`,
        suggestedTask: { title: 'Confirm first-fill shipment date', dueInDays: late ? 0 : 1 },
      };
    case 'ON_THERAPY':
      return {
        situation: `On therapy; ${d} days since the last refill check-in (every ${ctx.slaDays} days).`,
        urgency, contact: 'PATIENT',
        nextAction: late ? 'Call the patient for the overdue refill check-in and confirm adherence and the next shipment.'
                         : 'Schedule the next refill check-in call.',
        rationale: 'Regular check-ins catch missed refills before they become gaps in therapy.',
        suggestedTask: { title: 'Refill check-in call', dueInDays: late ? 0 : Math.max(0, ctx.slaDays - d) },
      };
    default:
      throw new Error(`Unknown step ${ctx.step}`);
  }
}
