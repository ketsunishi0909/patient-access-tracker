import { describe, expect, it } from 'vitest';
import { RulesDrafter } from '../src/agent/drafter';
import { createLocalApp } from '../src/local/server';
import { NOW } from './helpers';

/** End to end through the GraphQL schema and the Lambda handler, as AppSync would call it. */
describe('GraphQL API', () => {
  const app = createLocalApp({ drafter: new RulesDrafter(), now: () => NOW });

  it('rejects unauthenticated callers', async () => {
    const r = await (await app).execute({ query: '{ me { id } }' }, null);
    expect(r.errors?.[0]).toMatchObject({ errorType: 'FORBIDDEN', message: 'Not signed in' });
  });

  it('serves the dashboard with stuck cases flagged', async () => {
    const r = await (await app).execute({
      query: '{ dashboard { totalOpen steps { step total stuck atRisk } stuckCases { id slaState daysInStep slaDays } } }',
    }, 'u-sup-1');
    expect(r.errors).toBeUndefined();
    const d = (r.data as any).dashboard;  // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.totalOpen).toBeGreaterThan(30);
    expect(d.stuckCases.length).toBeGreaterThan(5);
    for (const c of d.stuckCases) {
      expect(c.slaState).toBe('STUCK');
      expect(c.daysInStep).toBeGreaterThanOrEqual(c.slaDays);
    }
  });

  it('runs the draft -> accept flow and shows it in the audit log', async () => {
    const a = await app;
    const list = await a.execute({ query: '{ cases(filter: { scope: MINE, slaState: STUCK }) { id step } }' }, 'u-cm-1');
    const target = (list.data as any).cases[0];  // eslint-disable-line @typescript-eslint/no-explicit-any
    const draft = await a.execute({
      query: 'mutation($id: ID!) { draftNextAction(caseId: $id) { nextAction urgency generatedBy suggestedTask { title dueInDays } } }',
      variables: { id: target.id },
    }, 'u-cm-1');
    expect(draft.errors).toBeUndefined();
    const d = (draft.data as any).draftNextAction;  // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d).toMatchObject({ urgency: 'HIGH', generatedBy: 'rules' });

    const accepted = await a.execute({
      query: 'mutation($id: ID!, $t: String!, $n: Int!) { acceptDraft(caseId: $id, title: $t, dueInDays: $n) { tasks { title source } } }',
      variables: { id: target.id, t: d.suggestedTask.title, n: d.suggestedTask.dueInDays },
    }, 'u-cm-1');
    expect((accepted.data as any).acceptDraft.tasks).toContainEqual({ title: d.suggestedTask.title, source: 'AI_DRAFT' });  // eslint-disable-line @typescript-eslint/no-explicit-any

    const audit = await a.execute({
      query: 'query($id: ID) { auditLog(caseId: $id) { items { actorName action outcome } } }', variables: { id: target.id },
    }, 'u-aud-1');
    const actions = (audit.data as any).auditLog.items.map((i: { action: string }) => i.action);  // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(actions).toEqual(expect.arrayContaining(['DRAFT_NEXT_ACTION', 'ACCEPT_DRAFT']));
  });

  it('returns typed errors for forbidden actions', async () => {
    const r = await (await app).execute({ query: '{ auditLog { items { id } } }' }, 'u-cm-1');
    expect(r.errors?.[0].errorType).toBe('FORBIDDEN');
  });
});
