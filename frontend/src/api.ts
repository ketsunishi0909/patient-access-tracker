import { useCallback, useEffect, useState } from 'react';
import { authHeaders } from './auth';

const URL = (import.meta.env.VITE_GRAPHQL_URL as string | undefined) ?? '/graphql';

export class ApiError extends Error {
  constructor(readonly errorType: string, message: string) {
    super(message);
  }
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  const err = body.errors?.[0];
  if (err) throw new ApiError(err.errorType ?? 'Error', err.message);
  if (!res.ok) throw new ApiError('HTTP', `Request failed (${res.status})`);
  return body.data as T;
}

/** Runs a query on mount (and when deps change); `reload` refetches. */
export function useQuery<T>(query: string, variables?: Record<string, unknown>) {
  const key = JSON.stringify(variables ?? {});
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    gql<T>(query, variables)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: ApiError) => setState({ data: null, error, loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, key]);
  useEffect(reload, [reload]);
  return { ...state, reload, setData: (data: T) => setState({ data, error: null, loading: false }) };
}

// ---------- shared types and fragments ----------

export type Step = 'ENROLLMENT' | 'BENEFITS_VERIFICATION' | 'PRIOR_AUTHORIZATION' | 'FIRST_FILL' | 'ON_THERAPY';
export type SlaState = 'ON_TRACK' | 'AT_RISK' | 'STUCK';
export type Role = 'INTAKE_COORDINATOR' | 'CASE_MANAGER' | 'SUPERVISOR' | 'COMPLIANCE_AUDITOR';

export const STEPS: { step: Step; short: string }[] = [
  { step: 'ENROLLMENT', short: 'Enrollment' },
  { step: 'BENEFITS_VERIFICATION', short: 'Benefits' },
  { step: 'PRIOR_AUTHORIZATION', short: 'Prior auth' },
  { step: 'FIRST_FILL', short: 'First fill' },
  { step: 'ON_THERAPY', short: 'On therapy' },
];

export interface StaffRef { id: string; name: string; role: Role | null }
export interface Me { id: string; name: string; role: Role; permissions: string[] }

export interface CaseSummary {
  id: string;
  patient: { displayName: string; dateOfBirth: string | null; memberId: string | null; phone: string | null; masked: boolean };
  therapy: string;
  payer: string;
  step: Step;
  stepLabel: string;
  status: string;
  owner: StaffRef | null;
  daysInStep: number;
  slaDays: number;
  slaState: SlaState;
  nextRefillDue: string | null;
  canEdit: boolean;
}

export interface CaseDetail extends CaseSummary {
  prescriber: { name: string; practice: string; phone: string | null };
  stepEnteredAt: string;
  createdAt: string;
  version: number;
  synthetic: boolean;
  canDraft: boolean;
  events: { id: string; at: string; type: string; actor: StaffRef | null; summary: string }[];
  tasks: { id: string; title: string; dueAt: string; assignee: StaffRef | null; status: string; source: string; overdue: boolean }[];
}

export const CASE_SUMMARY = `
  id therapy payer step stepLabel status daysInStep slaDays slaState nextRefillDue canEdit
  patient { displayName dateOfBirth memberId phone masked }
  owner { id name role }`;

export const CASE_DETAIL = `
  ${CASE_SUMMARY}
  prescriber { name practice phone }
  stepEnteredAt createdAt version synthetic canDraft
  events { id at type summary actor { id name role } }
  tasks { id title dueAt status source overdue assignee { id name role } }`;
