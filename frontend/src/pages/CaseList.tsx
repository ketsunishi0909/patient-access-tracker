import { useSearchParams } from 'react-router-dom';
import { CASE_SUMMARY, type CaseSummary, STEPS, useQuery } from '../api';
import { CaseTable } from '../components/ui';

export default function CaseList() {
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') ?? 'ALL';
  const sla = params.get('sla') ?? '';
  const step = params.get('step') ?? '';
  const filter = { scope, ...(sla ? { slaState: sla } : {}), ...(step ? { step } : {}) };
  const { data, error, loading } = useQuery<{ cases: CaseSummary[] }>(
    `query($f: CaseFilter) { cases(filter: $f) { ${CASE_SUMMARY} } }`, { f: filter });

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <>
      <div className="page-head"><h1>Cases</h1></div>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Scope">
          {[['ALL', 'All I can see'], ['MINE', 'Mine']].map(([v, l]) => (
            <button key={v} aria-pressed={scope === v} onClick={() => set('scope', v === 'ALL' ? '' : v)}>{l}</button>
          ))}
        </div>
        <select value={sla} onChange={(e) => set('sla', e.target.value)} aria-label="SLA state">
          <option value="">Any SLA state</option>
          <option value="STUCK">Stuck</option>
          <option value="AT_RISK">At risk</option>
          <option value="ON_TRACK">On track</option>
        </select>
        <select value={step} onChange={(e) => set('step', e.target.value)} aria-label="Step">
          <option value="">Any step</option>
          {STEPS.map((s) => <option key={s.step} value={s.step}>{s.short}</option>)}
        </select>
        {data && <span className="muted small">{data.cases.length} case{data.cases.length === 1 ? '' : 's'}</span>}
      </div>
      {error && <div className="error">{error.message}</div>}
      {loading && !data ? <p className="muted">Loading…</p> : data && <section className="card flush"><CaseTable cases={data.cases} empty="No cases match these filters." /></section>}
    </>
  );
}
