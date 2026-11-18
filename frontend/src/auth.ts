// Two sign-in modes:
//  - local:   pick a demo staff member; the local API trusts the x-demo-user header.
//  - cognito: Cognito hosted UI with the authorization-code + PKCE flow; the ID
//             token goes to AppSync, which validates it and passes the user's groups to the Lambda.

export const AUTH_MODE: 'local' | 'cognito' = import.meta.env.VITE_AUTH_MODE === 'cognito' ? 'cognito' : 'local';

export const DEMO_USERS = [
  { id: 'u-coord-1', name: 'Avery Lin', role: 'Intake coordinator' },
  { id: 'u-cm-1', name: 'Jordan Patel', role: 'Case manager' },
  { id: 'u-cm-2', name: 'Sam Rivera', role: 'Case manager' },
  { id: 'u-sup-1', name: 'Morgan Lee', role: 'Supervisor' },
  { id: 'u-aud-1', name: 'Riley Chen', role: 'Compliance auditor' },
];

const DEMO_KEY = 'pat.demoUser';
const TOKEN_KEY = 'pat.idToken';
const VERIFIER_KEY = 'pat.pkceVerifier';

function store(kind: 'local' | 'session', key: string, value?: string | null): string | null {
  try {
    const s = kind === 'local' ? localStorage : sessionStorage;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch { /* storage unavailable: fall back to defaults */ }
  return null;
}

export function getDemoUser(): string {
  return store('local', DEMO_KEY) ?? 'u-cm-1';
}

export function setDemoUser(id: string): void {
  store('local', DEMO_KEY, id);
}

/** Headers that identify the caller to the API. */
export function authHeaders(): Record<string, string> {
  if (AUTH_MODE === 'local') return { 'x-demo-user': getDemoUser() };
  const token = store('session', TOKEN_KEY);
  return token ? { Authorization: token } : {};
}

// ---------- Cognito (authorization code + PKCE) ----------

const cfg = {
  domain: import.meta.env.VITE_COGNITO_DOMAIN as string | undefined,
  clientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined,
  redirectUri: (import.meta.env.VITE_REDIRECT_URI as string | undefined) ?? `${location.origin}/`,
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function isSignedIn(): boolean {
  if (AUTH_MODE === 'local') return true;
  const token = store('session', TOKEN_KEY);
  if (!token) return false;
  try {
    const { exp } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return exp * 1000 > Date.now() + 30_000;
  } catch {
    return false;
  }
}

export async function signIn(): Promise<void> {
  if (!cfg.domain || !cfg.clientId) throw new Error('Cognito is not configured (VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID)');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  store('session', VERIFIER_KEY, verifier);
  const q = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'openid email profile', code_challenge: challenge, code_challenge_method: 'S256',
  });
  location.assign(`${cfg.domain}/oauth2/authorize?${q}`);
}

/** Completes the redirect from the hosted UI, if this page load is one. */
export async function completeSignIn(): Promise<void> {
  if (AUTH_MODE !== 'cognito') return;
  const code = new URLSearchParams(location.search).get('code');
  const verifier = store('session', VERIFIER_KEY);
  if (!code || !verifier || !cfg.domain || !cfg.clientId) return;
  const res = await fetch(`${cfg.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, code, redirect_uri: cfg.redirectUri, code_verifier: verifier }),
  });
  store('session', VERIFIER_KEY, null);
  history.replaceState(null, '', location.pathname);
  if (!res.ok) throw new Error('Sign-in failed');
  const { id_token } = await res.json();
  store('session', TOKEN_KEY, id_token);
}

export function signOut(): void {
  store('session', TOKEN_KEY, null);
  if (AUTH_MODE === 'cognito' && cfg.domain && cfg.clientId) {
    location.assign(`${cfg.domain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri })}`);
  }
}
