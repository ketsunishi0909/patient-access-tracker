import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { gql } from '../api';
import { roleLabel } from '../App';
import { fmtDate } from '../components/ui';

interface Entry {
  id: string; at: string; actorName: string; actorRole: string; action: string; outcome: string; caseIds: string[]; detail: string;
}

const QUERY = `query($c: ID, $n: String) { auditLog(caseId: $c, limit: 50, nextToken: $n) {
  nextToken items { id at actorName actorRole action outcome caseIds detail } } }`;

export default function AuditLog() {
  const [params, setParams] = useSearchParams();
  const caseId = params.get('case') ?? '';
  const [filter, setFilter] = useState(caseId);
  const [items, setItems] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (token: string | null, replace: boolean) => {
    try {
      const { auditLog } = await gql<{ auditLog: { items: Entry[]; nextToken: string | null } }>(QUERY, { c: caseId || null, n: token });
      setItems((prev) => (replace ? auditLog.items : [...prev, ...auditLog.items]));
      setNext(auditLog.nextToken);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => { void load(null, true); }, [caseId]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <span className="muted small">Append-only record of every read and change, including denied attempts. Viewing this page is itself recorded.</span>
      </div>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setParams(filter.trim() ? { case: filter.trim().toUpperCase() } : {}); }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by case ID, e.g. CASE-1004" aria-label="Case ID" />
        <button>Filter</button>
        {caseId && <button type="button" className="ghost" onClick={() => { setFilter(''); setParams({}); }}>Clear</button>}
      </form>
      {error && <div className="error">{error}</div>}
      <section className="card flush">
        <div className="table-wrap">
          <table className="audit">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Records</th><th>Detail</th></tr></thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className={e.outcome === 'DENIED' ? 'denied' : ''}>
                  <td className="nowrap">{fmtDate(e.at, true)}</td>
                  <td>{e.actorName}<div className="muted small">{roleLabel(e.actorRole)}</div></td>
                  <td className="mono small">{e.action}</td>
                  <td><span className={`badge ${e.outcome === 'DENIED' ? 'sla-stuck' : 'neutral'}`}>{e.outcome.toLowerCase()}</span></td>
                  <td className="small">
                    {e.caseIds.length === 0 ? '—' : e.caseIds.length <= 3
                      ? e.caseIds.map((id) => <Link key={id} className="mono" to={`/audit?case=${id}`}>{id} </Link>)
                      : <span title={e.caseIds.join(', ')}>{e.caseIds.length} cases</span>}
                  </td>
                  <td className="small muted">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && !error && <p className="muted empty">No entries.</p>}
        {next && <button className="load-more" onClick={() => void load(next, false)}>Load more</button>}
      </section>
    </>
  );
}
