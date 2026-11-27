import { useAuth } from './AuthProvider';

/** Full-page gate shown when signed out, waiting for a role, or unable to reach the API. */
export function SignInScreen() {
  const { status, me, error, signIn, signOut } = useAuth();

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/classone-logo.png" alt="Class One Systems" className="auth-logo" />
        <h1>ClassOne Discovery</h1>

        {status === 'loading' && <p className="muted">Checking your sign-in…</p>}

        {status === 'signed-out' && (
          <>
            <p className="muted">Sign in with your Google account to continue.</p>
            <button className="btn btn-primary" onClick={() => void signIn()}>
              Sign in with Google
            </button>
          </>
        )}

        {status === 'pending' && (
          <>
            <p>
              Signed in as <strong>{me?.email}</strong>.
            </p>
            <p className="muted">An admin needs to grant you access before you can use the app.</p>
            <button className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </>
        )}

        {status === 'error' && <p className="muted">{error}</p>}
        {status === 'signed-out' && error && <div className="alert alert-error" style={{ marginTop: 14 }}>{error}</div>}
      </div>
    </div>
  );
}
