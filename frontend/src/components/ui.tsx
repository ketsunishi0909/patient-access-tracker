import { Link } from 'react-router-dom';
import { type CaseSummary, type SlaState, STEPS, type Step } from '../api';

const SLA_TEXT: Record<SlaState, string> = { ON_TRACK: 'On track', AT_RISK: 'At risk', STUCK: 'Stuck' };

export function SlaBadge({ state, status }: { state: SlaState; status?: string }) {
  if (status && status !== 'ACTIVE') return <span className="badge neutral">{status === 'ON_HOLD' ? 'On hold' : status.toLowerCase()}</span>;
  return <span className={`badge sla-${state.toLowerCase().replace('_', '-')}`}>{SLA_TEXT[state]}</span>;
}

export function StepBar({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.step === step);
  return (
    <ol className="stepbar" aria-label="Access steps">
      {STEPS.map((s, i) => (
        <li key={s.step} className={i < current ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
          <span className="dot" aria-hidden>{i < current ? '✓' : i + 1}</span>
          <span>{s.short}</span>
        </li>
      ))}
    </ol>
  );
}

export function TimeInStep({ c }: { c: Pick<CaseSummary, 'daysInStep' | 'slaDays' | 'step'> }) {
  const pct = Math.min(100, (c.daysInStep / c.slaDays) * 100);
  const label = c.step === 'ON_THERAPY' ? 'since check-in' : 'in step';
  return (
    <div className="time-in-step" title={`${c.daysInStep} of ${c.slaDays} days`}>
      <span>{c.daysInStep}d {label} <span className="muted">/ {c.slaDays}d</span></span>
      <span className="meter" aria-hidden><span style={{ width: `${pct}%` }} className={pct >= 100 ? 'over' : pct >= 75 ? 'warn' : ''} /></span>
    </div>
  );
}

export function CaseTable({ cases, empty }: { cases: CaseSummary[]; empty: string }) {
  if (cases.length === 0) return <p className="muted empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="cases">
        <thead>
          <tr><th>Case</th><th>Patient</th><th>Step</th><th>Time</th><th>Status</th><th>Owner</th><th>Payer</th></tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td><Link to={`/cases/${c.id}`} className="mono">{c.id}</Link></td>
              <td>{c.patient.displayName}</td>
              <td>{c.stepLabel}</td>
              <td><TimeInStep c={c} /></td>
              <td><SlaBadge state={c.slaState} status={c.status} /></td>
              <td>{c.owner?.name ?? <span className="badge warn-outline">Unassigned</span>}</td>
              <td className="muted">{c.payer}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function fmtDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relDays(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  return days > 0 ? `in ${days}d` : `${-days}d ago`;
}
