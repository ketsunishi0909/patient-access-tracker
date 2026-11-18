import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { SLA_DAYS, STEP_LABELS } from '../domain/workflow';
import type { AgentContext } from './context';
import { rulesDraft } from './rules';
import { DraftSchema, type DraftResult, normalizeDraft } from './schema';

export interface Drafter {
  draft(ctx: AgentContext): Promise<DraftResult>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SLA_TABLE = Object.entries(SLA_DAYS).map(([s, d]) => `- ${STEP_LABELS[s as keyof typeof SLA_DAYS]}: ${d} days`).join('\n');

export const SYSTEM_PROMPT = `You help case managers at a patient access hub move patients through starting a specialty therapy: enrollment, benefits verification, prior authorization, first fill, then refill check-ins.

Given one case's de-identified history, draft the single most useful next action for the case owner. A person reviews every draft before anything happens, so write it for them: specific, short, and actionable today.

Ground every statement in the history provided. Do not assume events that are not recorded (for example, do not say a prior authorization was approved unless the history says so). When something needed is missing, the next action is to obtain it. Stay within access and coordination work: never suggest clinical, dosing or prescribing changes. Identifiers have been replaced with placeholders such as [PATIENT] and [PHONE]; keep the placeholders and do not try to fill them in.

Target time in each step before a case counts as stuck:
${SLA_TABLE}`;

/** Drafts next actions with Claude, returning a schema-validated structured result. */
export class ClaudeDrafter implements Drafter {
  constructor(private readonly client: Anthropic, private readonly model = DEFAULT_MODEL) {}

  async draft(ctx: AgentContext): Promise<DraftResult> {
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      // If a safety classifier declines, the API retries on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(DraftSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `<case_context>\n${JSON.stringify(ctx, null, 2)}\n</case_context>` }],
    });
    if (res.stop_reason === 'refusal') throw new DraftUnavailable('model declined the request');
    if (res.stop_reason === 'max_tokens') throw new DraftUnavailable('model output was truncated');
    if (!res.parsed_output) throw new DraftUnavailable('model output did not match the draft schema');
    return { draft: normalizeDraft(res.parsed_output), generatedBy: res.model, fallbackReason: null };
  }
}

export class DraftUnavailable extends Error {}

export class RulesDrafter implements Drafter {
  async draft(ctx: AgentContext): Promise<DraftResult> {
    return { draft: rulesDraft(ctx), generatedBy: 'rules', fallbackReason: 'no model configured' };
  }
}

/** Tries the model first; any failure degrades to the rules drafter instead of blocking the user. */
export class FallbackDrafter implements Drafter {
  constructor(private readonly primary: Drafter, private readonly onError: (err: unknown) => void = () => {}) {}

  async draft(ctx: AgentContext): Promise<DraftResult> {
    try {
      return await this.primary.draft(ctx);
    } catch (err) {
      this.onError(err);
      return { draft: rulesDraft(ctx), generatedBy: 'rules', fallbackReason: describe(err) };
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof DraftUnavailable) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'model credentials missing or invalid';
  if (err instanceof Anthropic.RateLimitError) return 'model rate limited';
  if (err instanceof Anthropic.APIConnectionError) return 'model unreachable';
  if (err instanceof Anthropic.APIError) return `model error (HTTP ${err.status ?? '?'})`;
  return 'model call failed';
}
