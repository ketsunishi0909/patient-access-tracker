import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentContext, scrub } from '../src/agent/context';
import { ClaudeDrafter, FallbackDrafter, SYSTEM_PROMPT } from '../src/agent/drafter';
import { rulesDraft } from '../src/agent/rules';
import type { Draft } from '../src/agent/schema';
import { caseMeta, DAY, manager, NOW, seededService, serviceWith } from './helpers';

const sampleDraft: Draft = {
  situation: 'Prior authorization pending 9 days; payer asked for chart notes 6 days ago.',
  nextAction: "Call the prescriber's office to confirm the chart notes were faxed to the payer.",
  rationale: 'The voicemail 4 days ago got no reply and the case is past its 7-day target.',
  urgency: 'HIGH', contact: 'PRESCRIBER_OFFICE',
  suggestedTask: { title: 'Follow up on PA chart notes', dueInDays: 99 },
};

function mockClient(response: Record<string, unknown>) {
  const parse = vi.fn(async () => response);
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe('de-identification', () => {
  it('never puts patient or prescriber identifiers in the model context, for any seeded case', async () => {
    const { data } = await seededService();
    for (const rec of data.cases) {
      const json = JSON.stringify(buildAgentContext(rec, NOW));
      const p = rec.meta.patient;
      for (const secret of [p.firstName, p.lastName, p.dateOfBirth, p.memberId, p.phone, rec.meta.prescriber.name, rec.meta.prescriber.phone]) {
        expect(json, `${rec.meta.id} leaks "${secret}"`).not.toContain(secret);
      }
    }
  });

  it('scrubs free text that mentions identifiers in other formats', () => {
    const rec = { meta: caseMeta(), events: [], tasks: [] };
    const out = scrub('Spoke to WREN ashdown (DOB 4/9/1971, member SYN-00112233) at (555) 014-2000, email wren@example.com; Dr. Imogen Halvorsen to fax 2026-11-02', rec);
    expect(out).toBe('Spoke to [PATIENT] (DOB [DOB], member [MEMBER_ID]) at [PHONE], email [EMAIL]; [PRESCRIBER] to fax [DATE]');
  });
});

describe('ClaudeDrafter', () => {
  it('sends a structured-output request and normalizes the result', async () => {
    const { client, parse } = mockClient({ stop_reason: 'end_turn', parsed_output: sampleDraft, model: 'claude-opus-5-5' });
    const ctx = buildAgentContext({ meta: caseMeta(), events: [], tasks: [] }, NOW);
    const r = await new ClaudeDrafter(client).draft(ctx);

    const req = (parse.mock.calls[0] as unknown[])[0] as Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.fallbacks).toBe('default');
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.output_config.effort).toBe('medium');
    expect(req.output_config.format).toBeDefined();
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.messages[0].content).toContain('"caseRef": "CASE-T1"');
    expect(req.messages[0].content).not.toContain('Ashdown');

    expect(r.generatedBy).toBe('claude-opus-5-5');
    expect(r.draft.suggestedTask.dueInDays).toBe(14);  // clamped from 99
  });

  it('falls back to the rules drafter on refusal, schema mismatch, or API errors', async () => {
    const ctx = buildAgentContext({ meta: caseMeta(), events: [], tasks: [] }, NOW);
    const cases: [Record<string, unknown> | Error, string][] = [
      [{ stop_reason: 'refusal', parsed_output: null, model: 'claude-opus-5-5' }, 'model declined the request'],
      [{ stop_reason: 'end_turn', parsed_output: null, model: 'claude-opus-5-5' }, 'model output did not match the draft schema'],
      [new Anthropic.APIConnectionError({ message: 'offline' }), 'model unreachable'],
    ];
    for (const [resp, reason] of cases) {
      const parse = vi.fn(async () => { if (resp instanceof Error) throw resp; return resp; });
      const client = { beta: { messages: { parse } } } as unknown as Anthropic;
      const r = await new FallbackDrafter(new ClaudeDrafter(client)).draft(ctx);
      expect(r).toMatchObject({ generatedBy: 'rules', fallbackReason: reason });
      expect(r.draft.contact).toBe('PRESCRIBER_OFFICE');
    }
  });
});

describe('rules drafter', () => {
  it('flags a stuck prior authorization for follow-up with the prescriber office', () => {
    const d = rulesDraft(buildAgentContext({ meta: caseMeta(), events: [], tasks: [] }, NOW));
    expect(d).toMatchObject({ urgency: 'HIGH', contact: 'PRESCRIBER_OFFICE', situation: 'Prior authorization pending 9 days (target 7).' });
    expect(d.nextAction).toMatch(/prescriber's office/);
  });

  it('asks for an owner first on unassigned cases', () => {
    expect(rulesDraft(buildAgentContext({ meta: caseMeta({ ownerId: null }), events: [], tasks: [] }, NOW)).nextAction).toMatch(/Assign an owner/);
  });
});

describe('draft workflow', () => {
  it('drafts without saving anything, then turns an accepted draft into an attributed task', async () => {
    const { client } = mockClient({ stop_reason: 'end_turn', parsed_output: sampleDraft, model: 'claude-opus-5-5' });
    const { svc, repo } = await serviceWith([caseMeta()], new ClaudeDrafter(client));
    const before = await repo.getCase('CASE-T1');

    const draft = await svc.draftNextAction(manager, 'CASE-T1');
    expect(draft).toMatchObject({ caseId: 'CASE-T1', generatedBy: 'claude-opus-5-5', urgency: 'HIGH' });
    expect(draft.withheldFields).toContain('patient.dateOfBirth');
    expect((await repo.getCase('CASE-T1'))!.meta.version).toBe(before!.meta.version);

    const after = await svc.acceptDraft(manager, 'CASE-T1', draft.suggestedTask.title, draft.suggestedTask.dueInDays, draft.rationale);
    const task = after.tasks.find((t) => t.source === 'AI_DRAFT')!;
    expect(task.title).toBe('Follow up on PA chart notes');
    expect(new Date(task.dueAt).getTime() - NOW.getTime()).toBe(14 * DAY);
    expect(after.events[0].type).toBe('AI_DRAFT_ACCEPTED');

    const audit = (await repo.listAudit({ caseId: 'CASE-T1', limit: 10 })).items.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['DRAFT_NEXT_ACTION', 'ACCEPT_DRAFT']));
    const draftAudit = (await repo.listAudit({ caseId: 'CASE-T1', limit: 10 })).items.find((e) => e.action === 'DRAFT_NEXT_ACTION');
    expect(draftAudit?.detail).toMatch(/generatedBy=claude-opus-5-5; withheld 7 identifier fields/);
  });
});
