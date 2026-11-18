import { z } from 'zod';

/** Structured next-action draft. The model must return exactly this shape. */
export const DraftSchema = z.object({
  situation: z.string().describe('One or two sentences on where the case stands and why it matters now.'),
  nextAction: z.string().describe('The single most useful next action, phrased as an instruction to the case owner.'),
  rationale: z.string().describe('Why this action, citing specific history entries (by days ago).'),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  contact: z.enum(['PRESCRIBER_OFFICE', 'PAYER', 'PATIENT', 'SPECIALTY_PHARMACY', 'INTERNAL', 'NONE']),
  suggestedTask: z.object({
    title: z.string().describe('Short task title, under 80 characters.'),
    dueInDays: z.number().int().describe('Days from today, 0 to 14.'),
  }),
});

export type Draft = z.infer<typeof DraftSchema>;

export interface DraftResult {
  draft: Draft;
  /** The model ID that produced the draft, or "rules" for the deterministic fallback. */
  generatedBy: string;
  fallbackReason: string | null;
}

/** Keeps model output inside the bounds the UI and task system accept. */
export function normalizeDraft(d: Draft): Draft {
  return {
    ...d,
    suggestedTask: {
      title: d.suggestedTask.title.slice(0, 120),
      dueInDays: Math.min(14, Math.max(0, Math.round(d.suggestedTask.dueInDays))),
    },
  };
}
