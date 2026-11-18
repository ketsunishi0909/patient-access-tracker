import { Link } from 'react-router-dom';
import { CASE_SUMMARY, type CaseSummary, type Step, useQuery } from '../api';
import { CaseTable } from '../components/ui';

interface DashboardData {
  dashboard: {
    generatedAt: string;
    totalOpen: number;
    unassigned: number;
    steps: { step: Step; label: string; total: number; onTrack: number; atRisk: number; stuck: number; onHold: number }[];
    stuckCases: CaseSummary[];
  };
}

const QUERY = `{ dashboard { generatedAt totalOpen unassigned steps { step label total onTrack atRisk stuck onHold } stuckCases { ${CASE_SUMMARY} } } }`;

export default function Dashboard() {
  const { data, error, loading } = useQuery<DashboardData>(QUERY);
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <p className="muted">{loading ? 'Loading…' : ''}</p>;
  const d = data.dashboard;
  const stuck = d.steps.reduce((n, s) => n + s.stuck, 0);
  const atRisk = d.steps.reduce((n, s) => n + s.atRisk, 0);
  const max = Math.max(1, ...d.steps.map((s) => s.total));

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className="muted small">Cases you can see · updated {new Date(d.generatedAt).toLocaleTimeString()}</span>
      </div>

      <section className="tiles">
        <Tile label="Open cases" value={d.totalOpen} />
        <Tile label="Stuck" value={stuck} tone="bad" to="/cases?sla=STUCK" />
        <Tile label="At risk" value={atRisk} tone="warn" to="/cases?sla=AT_RISK" />
        <Tile label="Unassigned" value={d.unassigned} />
      </section>

      <section className="card">
        <h2>Pipeline by step</h2>
        <div className="pipeline">
          {d.steps.map((s) => (
            <Link key={s.step} to={`/cases?step=${s.step}`} className="pipe-row">
              <span className="pipe-label">{s.label}</span>
              <span className="pipe-bar" role="img" aria-label={`${s.total} cases: ${s.onTrack} on track, ${s.atRisk} at risk, ${s.stuck} stuck`}>
                <span className="seg ok" style={{ width: `${(s.onTrack / max) * 100}%` }} />
                <span className="seg warn" style={{ width: `${(s.atRisk / max) * 100}%` }} />
                <span className="seg bad" style={{ width: `${(s.stuck / max) * 100}%` }} />
              </span>
              <span className="pipe-count">
                <strong>{s.total}</strong>
                {s.stuck > 0 && <span className="text-bad"> · {s.stuck} stuck</span>}
              </span>
            </Link>
          ))}
        </div>
        <div className="legend small muted">
          <span><i className="swatch ok" />On track</span>
          <span><i className="swatch warn" />At risk (≥75% of target)</span>
          <span><i className="swatch bad" />Stuck (past target)</span>
        </div>
      </section>

      <section className="card">
        <h2>Stuck cases <span className="muted small">longest past target first</span></h2>
        <CaseTable cases={d.stuckCases} empty="Nothing is stuck. Nice." />
      </section>
    </>
  );
}

function Tile({ label, value, tone, to }: { label: string; value: number; tone?: 'bad' | 'warn'; to?: string }) {
  const body = (<><span className="tile-value">{value}</span><span className="tile-label">{label}</span></>);
  return to ? <Link to={to} className={`tile ${tone ?? ''}`}>{body}</Link> : <div className={`tile ${tone ?? ''}`}>{body}</div>;
}
