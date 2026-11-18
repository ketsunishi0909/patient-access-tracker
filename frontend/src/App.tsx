import { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { type Me, useQuery } from './api';
import { AUTH_MODE, completeSignIn, DEMO_USERS, getDemoUser, isSignedIn, setDemoUser, signIn, signOut } from './auth';
import AuditLog from './pages/AuditLog';
import CaseDetail from './pages/CaseDetail';
import CaseList from './pages/CaseList';
import Dashboard from './pages/Dashboard';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);
export const canDo = (me: Me | null, p: string) => Boolean(me?.permissions.includes(p));

const ROLE_LABEL: Record<string, string> = {
  INTAKE_COORDINATOR: 'Intake coordinator', CASE_MANAGER: 'Case manager',
  SUPERVISOR: 'Supervisor', COMPLIANCE_AUDITOR: 'Compliance auditor',
};
export const roleLabel = (r: string | null | undefined) => (r ? ROLE_LABEL[r] ?? r : '');

export default function App() {
  const [ready, setReady] = useState(AUTH_MODE === 'local');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (AUTH_MODE === 'local') return;
    completeSignIn().then(() => setReady(true)).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="center-card"><h1>Sign-in failed</h1><p>{error}</p></div>;
  if (!ready) return null;
  if (!isSignedIn()) {
    return (
      <div className="center-card">
        <h1>Patient Access Tracker</h1>
        <p>Synthetic data only. Sign in with your staff account.</p>
        <button className="primary" onClick={() => void signIn()}>Sign in</button>
      </div>
    );
  }
  return <BrowserRouter><Shell key={AUTH_MODE === 'local' ? getDemoUser() : 'cognito'} /></BrowserRouter>;
}

function Shell() {
  const { data, error } = useQuery<{ me: Me }>('{ me { id name role permissions } }');
  const me = data?.me ?? null;
  return (
    <MeContext.Provider value={me}>
      <div className="synthetic-banner" role="note">Synthetic demo data only. No real patient information is stored or shown.</div>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◆</span>
          <span>Patient Access Tracker</span>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/cases">Cases</NavLink>
          {canDo(me, 'audit:view') && <NavLink to="/audit">Audit log</NavLink>}
        </nav>
        <UserMenu me={me} />
      </header>
      <main>
        {error && <div className="error">{error.message}</div>}
        {me && (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cases" element={<CaseList />} />
            <Route path="/cases/:id" element={<CaseDetail />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        )}
      </main>
    </MeContext.Provider>
  );
}

function UserMenu({ me }: { me: Me | null }) {
  if (AUTH_MODE === 'cognito') {
    return (
      <div className="user">
        <span>{me?.name} · {roleLabel(me?.role)}</span>
        <button className="ghost" onClick={signOut}>Sign out</button>
      </div>
    );
  }
  return (
    <label className="user">
      <span className="muted small">Signed in as (demo)</span>
      <select
        value={getDemoUser()}
        onChange={(e) => { setDemoUser(e.target.value); location.assign('/'); }}
        aria-label="Switch demo user"
      >
        {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
      </select>
    </label>
  );
}
