import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, CASE_DETAIL, type CaseDetail as Case, gql, type StaffRef, useQuery } from '../api';
import { canDo, roleLabel, useMe } from '../App';
import { fmtDate, relDays, SlaBadge, StepBar, TimeInStep } from '../components/ui';

interface Draft {
  situation: string;
  nextAction: string;
  rationale: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  contact: string;
  suggestedTask: { title: string; dueInDays: number };
  generatedBy: string;
  fallbackReason: string | null;
  withheldFields: string[];
}

const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Opened', STEP_ADVANCED: 'Step', STATUS_CHANGED: 'Status', OWNER_CHANGED: 'Owner', NOTE: 'Note', CALL: 'Call',
  TASK_CREATED: 'Task', TASK_COMPLETED: 'Done', REFILL_CHECKIN: 'Refill', AI_DRAFT_ACCEPTED: 'AI draft',
};

export default function CaseDetail() {
  const { id = '' } = useParams();
  const me = useMe();
  const { data, error, setData } = useQuery<{ case: Case | null }>(`query($id: ID!) { case(id: $id) { ${CASE_DETAIL} } }`, { id });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <div className="error">{error.errorType === 'FORBIDDEN' ? `You don't have access to ${id}. This attempt was recorded in the audit log.` : error.message}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const c = data.case;
  if (!c) return <p>Case not found.</p>;

  /** Runs a mutation that returns the updated case. */
  const run = async (mutation: string, vars: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await gql<Record<string, Case>>(mutation, { id: c.id, ...vars });
      setData({ case: Object.values(out)[0] });
      return true;
    } catch (e) {
      setActionError(e instanceof ApiError && e.errorType === 'CONFLICT' ? `${e.message}` : (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="crumbs"><Link to="/cases">Cases</Link> / <span className="mono">{c.id}</span></div>
      <section className="case-head card">
        <div className="case-title">
          <h1>{c.patient.displayName}</h1>
          <SlaBadge state={c.slaState} status={c.status} />
          {c.patient.masked && <span className="badge neutral" title="Protected fields are hidden for your role">Protected fields masked</span>}
        </div>
        <dl className="facts">
          <div><dt>Case</dt><dd className="mono">{c.id}</dd></div>
          <div><dt>Therapy</dt><dd>{c.therapy}</dd></div>
          <div><dt>Payer</dt><dd>{c.payer}</dd></div>
          <div><dt>Member ID</dt><dd className="mono">{c.patient.memberId ?? '—'}</dd></div>
          <div><dt>Date of birth</dt><dd>{c.patient.dateOfBirth ?? '—'}</dd></div>
          <div><dt>Phone</dt><dd>{c.patient.phone ?? '—'}</dd></div>
          <div><dt>Prescriber</dt><dd>{c.prescriber.name}<br /><span className="muted small">{c.prescriber.practice}{c.prescriber.phone ? ` · ${c.prescriber.phone}` : ''}</span></dd></div>
          <div><dt>Owner</dt><dd><OwnerControl c={c} busy={busy} run={run} /></dd></div>
        </dl>
        <StepBar step={c.step} />
        <div className="step-status">
          <TimeInStep c={c} />
          <span className="muted small">
            In {c.stepLabel.toLowerCase()} since {fmtDate(c.stepEnteredAt)}
            {c.nextRefillDue && ` · next refill check-in due ${fmtDate(c.nextRefillDue)}`}
          </span>
        </div>
      </section>

      {actionError && <div className="error" role="alert">{actionError}</div>}

      <div className="case-grid">
        <div className="col">
          {c.canEdit && <Actions c={c} busy={busy} run={run} />}
          <section className="card">
            <h2>Timeline</h2>
            <ol className="timeline">
              {c.events.map((e) => (
                <li key={e.id} className={`ev ev-${e.type.toLowerCase()}`}>
                  <span className="ev-type">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <div>
                    <p>{e.summary}</p>
                    <span className="muted small">{fmtDate(e.at, true)} · {e.actor?.name ?? 'System'}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <div className="col">
          {c.canDraft && <DraftPanel c={c} busy={busy} run={run} />}
          <Tasks c={c} busy={busy} run={run} />
          {canDo(me, 'audit:view') && <Link className="small" to={`/audit?case=${c.id}`}>View access history for this case →</Link>}
        </div>
      </div>
    </>
  );
}

type RunFn = (mutation: string, vars: Record<string, unknown>) => Promise<boolean>;

function OwnerControl({ c, busy, run }: { c: Case; busy: boolean; run: RunFn }) {
  const me = useMe();
  const staff = useQuery<{ staff: StaffRef[] }>('{ staff { id name role } }');
  const assign = (ownerId: string | null) => run('mutation($id: ID!, $o: ID) { assignCase(caseId: $id, ownerId: $o) { ' + CASE_DETAIL + ' } }', { o: ownerId });
  if (canDo(me, 'case:assign') && staff.data) {
    return (
      <select value={c.owner?.id ?? ''} disabled={busy} onChange={(e) => void assign(e.target.value || null)} aria-label="Case owner">
        <option value="">Unassigned</option>
        {staff.data.staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({roleLabel(s.role)})</option>)}
      </select>
    );
  }
  if (!c.owner) {
    return c.canEdit && me
      ? <button className="small-btn" disabled={busy} onClick={() => void assign(me.id)}>Unassigned · claim it</button>
      : <span className="badge warn-outline">Unassigned</span>;
  }
  return <>{c.owner.name}</>;
}

function Actions({ c, busy, run }: { c: Case; busy: boolean; run: RunFn }) {
  const [kind, setKind] = useState<'CALL' | 'NOTE'>('CALL');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<null | 'advance' | 'hold' | 'resume' | 'close'>(null);
  const [reason, setReason] = useState('');

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('mutation($id: ID!, $k: NoteKind!, $t: String!) { addNote(caseId: $id, kind: $k, text: $t) { ' + CASE_DETAIL + ' } }', { k: kind, t: text })) setText('');
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    const ok = mode === 'advance'
      ? await run('mutation($id: ID!, $v: Int!, $n: String) { advanceStep(caseId: $id, expectedVersion: $v, note: $n) { ' + CASE_DETAIL + ' } }', { v: c.version, n: reason })
      : mode === 'hold' || mode === 'resume' || mode === 'close'
        ? await run('mutation($id: ID!, $v: Int!, $s: CaseStatus!, $r: String!) { setStatus(caseId: $id, expectedVersion: $v, status: $s, reason: $r) { ' + CASE_DETAIL + ' } }',
            { v: c.version, s: mode === 'hold' ? 'ON_HOLD' : mode === 'resume' ? 'ACTIVE' : 'DISCONTINUED', r: reason })
        : false;
    if (ok) { setMode(null); setReason(''); }
  };
  const checkIn = () => run('mutation($id: ID!) { recordRefillCheckIn(caseId: $id, note: "Check-in call completed") { ' + CASE_DETAIL + ' } }', {});

  return (
    <section className="card">
      <h2>Work the case</h2>
      <div className="btn-row">
        {c.status === 'ACTIVE' && c.step !== 'ON_THERAPY' && <button className="primary" disabled={busy} onClick={() => setMode('advance')}>Complete {c.stepLabel.toLowerCase()} →</button>}
        {c.status === 'ACTIVE' && c.step === 'ON_THERAPY' && <button className="primary" disabled={busy} onClick={() => void checkIn()}>Record refill check-in</button>}
        {c.status === 'ACTIVE' && <button disabled={busy} onClick={() => setMode('hold')}>Put on hold</button>}
        {c.status === 'ON_HOLD' && <button disabled={busy} onClick={() => setMode('resume')}>Resume</button>}
        {(c.status === 'ACTIVE' || c.status === 'ON_HOLD') && <button className="ghost" disabled={busy} onClick={() => setMode('close')}>Discontinue…</button>}
      </div>
      {mode && (
        <form className="inline-form" onSubmit={confirm}>
          <label>
            {mode === 'advance' ? 'Note (optional)' : 'Reason (required)'}
            <input value={reason} onChange={(e) => setReason(e.target.value)} required={mode !== 'advance'} autoFocus
                   placeholder={mode === 'advance' ? 'e.g. PA approved, auth valid 12 months' : 'e.g. patient traveling until the 30th'} />
          </label>
          <button className="primary" disabled={busy}>Confirm</button>
          <button type="button" className="ghost" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      <form className="note-form" onSubmit={addNote}>
        <div className="segmented" role="group" aria-label="Entry type">
          <button type="button" aria-pressed={kind === 'CALL'} onClick={() => setKind('CALL')}>Log call</button>
          <button type="button" aria-pressed={kind === 'NOTE'} onClick={() => setKind('NOTE')}>Add note</button>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} required
                  placeholder={kind === 'CALL' ? "Who you called and what happened, e.g. called prescriber office, left voicemail" : 'Note'} />
        <button disabled={busy || !text.trim()}>Save</button>
      </form>
    </section>
  );
}

function DraftPanel({ c, busy, run }: { c: Case; busy: boolean; run: RunFn }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(0);

  const generate = async () => {
    setLoading(true);
    setErr(null);
    try {
      const { draftNextAction: d } = await gql<{ draftNextAction: Draft }>(
        `mutation($id: ID!) { draftNextAction(caseId: $id) { situation nextAction rationale urgency contact
           suggestedTask { title dueInDays } generatedBy fallbackReason withheldFields } }`, { id: c.id });
      setDraft(d);
      setTitle(d.suggestedTask.title);
      setDue(d.suggestedTask.dueInDays);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const accept = async () => {
    if (!draft) return;
    const ok = await run('mutation($id: ID!, $t: String!, $d: Int!, $r: String) { acceptDraft(caseId: $id, title: $t, dueInDays: $d, rationale: $r) { ' + CASE_DETAIL + ' } }',
      { t: title, d: due, r: draft.nextAction });
    if (ok) setDraft(null);
  };

  return (
    <section className="card draft">
      <div className="draft-head">
        <h2>Next action</h2>
        <button onClick={() => void generate()} disabled={loading || busy}>{loading ? 'Drafting…' : draft ? 'Redraft' : 'Draft next action'}</button>
      </div>
      {!draft && !loading && (
        <p className="muted small">Reads this case's history and suggests what to do next. Patient identifiers are removed before anything is sent to the model, and nothing changes until you accept.</p>
      )}
      {err && <div className="error">{err}</div>}
      {draft && (
        <div className="draft-body">
          <div className="draft-meta">
            <span className={`badge urg-${draft.urgency.toLowerCase()}`}>{draft.urgency} urgency</span>
            <span className="badge neutral">Contact: {draft.contact.replace(/_/g, ' ').toLowerCase()}</span>
          </div>
          <p className="draft-situation">{draft.situation}</p>
          <p className="draft-action"><strong>{draft.nextAction}</strong></p>
          <p className="muted small">{draft.rationale}</p>
          <div className="draft-accept">
            <label>Task <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label>Due in (days) <input type="number" min={0} max={14} value={due} onChange={(e) => setDue(Number(e.target.value))} /></label>
            <div className="btn-row">
              <button className="primary" disabled={busy || !title.trim()} onClick={() => void accept()}>Create task</button>
              <button className="ghost" onClick={() => setDraft(null)}>Dismiss</button>
            </div>
          </div>
          <p className="provenance small muted">
            {draft.generatedBy === 'rules'
              ? `Drafted by playbook rules${draft.fallbackReason ? ` (${draft.fallbackReason})` : ''}.`
              : `Drafted by ${draft.generatedBy}.`}{' '}
            {draft.withheldFields.length} identifier fields were withheld. AI-drafted suggestion: review before acting.
          </p>
        </div>
      )}
    </section>
  );
}

function Tasks({ c, busy, run }: { c: Case; busy: boolean; run: RunFn }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(() => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
  const open = c.tasks.filter((t) => t.status === 'OPEN');
  const done = c.tasks.filter((t) => t.status === 'DONE');
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('mutation($id: ID!, $t: String!, $d: AWSDateTime!) { addTask(caseId: $id, title: $t, dueAt: $d) { ' + CASE_DETAIL + ' } }',
      { t: title, d: new Date(`${due}T17:00:00`).toISOString() })) setTitle('');
  };
  return (
    <section className="card">
      <h2>Tasks</h2>
      {open.length === 0 && <p className="muted small">No open tasks.</p>}
      <ul className="tasks">
        {open.map((t) => (
          <li key={t.id} className={t.overdue ? 'overdue' : ''}>
            {c.canEdit && (
              <input type="checkbox" aria-label={`Complete ${t.title}`} disabled={busy}
                     onChange={() => void run('mutation($id: ID!, $t: ID!) { completeTask(caseId: $id, taskId: $t) { ' + CASE_DETAIL + ' } }', { t: t.id })} />
            )}
            <div>
              <span>{t.title}</span>{t.source === 'AI_DRAFT' && <span className="badge neutral tiny">from AI draft</span>}
              <div className="muted small">{t.overdue ? <span className="text-bad">Overdue · </span> : null}due {relDays(t.dueAt)} · {t.assignee?.name ?? 'unassigned'}</div>
            </div>
          </li>
        ))}
      </ul>
      {c.canEdit && (
        <form className="task-form" onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" aria-label="New task title" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <button disabled={busy || !title.trim()}>Add</button>
        </form>
      )}
      {done.length > 0 && <details className="small"><summary>{done.length} completed</summary><ul className="tasks done">{done.map((t) => <li key={t.id}><span>{t.title}</span></li>)}</ul></details>}
    </section>
  );
}
