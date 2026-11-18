import { slaInfo, STEP_LABELS } from '../domain/workflow';
import type { CaseRecord, EventType } from '../domain/types';

/**
 * What the drafting model is allowed to see about a case. Direct identifiers
 * (name, date of birth, member ID, phone numbers) are never included, and
 * free-text notes are scrubbed of them before they leave this process.
 */
export interface AgentContext {
  caseRef: string;
  status: string;
  step: string;
  stepLabel: string;
  daysInStep: number;
  slaDays: number;
  slaState: string;
  therapy: string;
  payer: string;
  hasOwner: boolean;
  openTasks: { title: string; dueInDays: number; overdue: boolean }[];
  history: { daysAgo: number; type: EventType; summary: string }[];
}

export const WITHHELD_FIELDS = ['patient.firstName', 'patient.lastName', 'patient.dateOfBirth', 'patient.memberId',
                                'patient.phone', 'prescriber.name', 'prescriber.phone'] as const;

const MAX_HISTORY = 40;
const DAY_MS = 86_400_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes identifiers from free text: the case's own identifiers first, then any phone or date pattern. */
export function scrub(text: string, rec: CaseRecord): string {
  const p = rec.meta.patient;
  const [y, m, d] = p.dateOfBirth.split('-');
  const replacements: [RegExp, string][] = [
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]'],  // before names, so "name@domain" goes as a whole
    [new RegExp(`\\b${escape(p.firstName)}\\s+${escape(p.lastName)}\\b`, 'gi'), '[PATIENT]'],
    [new RegExp(`\\b${escape(p.lastName)}\\b`, 'gi'), '[PATIENT]'],
    [new RegExp(`\\b${escape(p.firstName)}\\b`, 'gi'), '[PATIENT]'],
    [new RegExp(escape(p.memberId), 'gi'), '[MEMBER_ID]'],
    [new RegExp(escape(p.phone), 'g'), '[PHONE]'],
    [new RegExp(escape(rec.meta.prescriber.phone), 'g'), '[PHONE]'],
    [new RegExp(`\\b${escape(rec.meta.prescriber.name)}\\b`, 'gi'), '[PRESCRIBER]'],
    [new RegExp(`\\b${Number(m)}/${Number(d)}/(${y}|${y.slice(2)})\\b`, 'g'), '[DOB]'],
    [new RegExp(`\\b${y}-${m}-${d}\\b`, 'g'), '[DOB]'],
    [/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]\d{4}\b/g, '[PHONE]'],
    [/\b\d{3}[-.]\d{4}\b/g, '[PHONE]'],  // 7-digit local numbers
    [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[DATE]'],
    [/\b\d{4}-\d{2}-\d{2}\b/g, '[DATE]'],
  ];
  return replacements.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

export function buildAgentContext(rec: CaseRecord, now: Date): AgentContext {
  const c = rec.meta;
  const sla = slaInfo(c, now);
  const daysUntil = (iso: string) => Math.round((new Date(iso).getTime() - now.getTime()) / DAY_MS);
  return {
    caseRef: c.id,
    status: c.status,
    step: c.step,
    stepLabel: STEP_LABELS[c.step],
    daysInStep: sla.daysInStep,
    slaDays: sla.slaDays,
    slaState: sla.slaState,
    therapy: c.therapy,
    payer: c.payer,
    hasOwner: c.ownerId !== null,
    openTasks: rec.tasks.filter((t) => t.status === 'OPEN').map((t) => ({
      title: scrub(t.title, rec),
      dueInDays: daysUntil(t.dueAt),
      overdue: new Date(t.dueAt) < now,
    })),
    history: rec.events
      .slice()
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-MAX_HISTORY)
      .map((e) => ({
        daysAgo: Math.floor((now.getTime() - new Date(e.at).getTime()) / DAY_MS),
        type: e.type,
        summary: scrub(e.summary, rec),
      })),
  };
}
