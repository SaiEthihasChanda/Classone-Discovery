/**
 * Sign-in state for the whole app.
 *
 * Firebase handles the Google sign-in; the API's /me says who that is and what
 * role they hold. When the API runs with AUTH_ENABLED=false (local dev), /me
 * answers without a token and the app opens straight in, so Firebase is only
 * initialised when its config is present.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut as fbSignOut, type User } from 'firebase/auth';
import { api, ApiError, setTokenProvider, type Me } from '../api/client';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
function firebaseApp(): FirebaseApp | null {
  if (!config.apiKey) return null;
  app ??= initializeApp(config);
  return app;
}

type Status = 'loading' | 'signed-out' | 'pending' | 'ready' | 'error';

interface AuthState {
  status: Status;
  me: Me | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** True when the signed-in role may do `level` (sales ⊃ viewer, admin ⊃ sales). */
  can: (level: 'viewer' | 'sales' | 'admin') => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

const RANK: Record<string, number> = { pending: 0, viewer: 1, sales: 2, admin: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const who = await api.me();
      setMe(who);
      setStatus(who.role === 'pending' ? 'pending' : 'ready');
      setError(null);
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status === 401) setStatus('signed-out');
      else {
        setError(err instanceof Error ? err.message : 'Could not reach the API');
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    const fb = firebaseApp();
    if (!fb) {
      // No Firebase config: the API must be running with auth off.
      setTokenProvider(null);
      void loadMe();
      return;
    }
    const auth = getAuth(fb);
    return onAuthStateChanged(auth, (user: User | null) => {
      setTokenProvider(user ? () => user.getIdToken() : null);
      void loadMe();
    });
  }, [loadMe]);

  const signIn = useCallback(async () => {
    const fb = firebaseApp();
    if (!fb) return;
    setError(null);
    try {
      await signInWithPopup(getAuth(fb), new GoogleAuthProvider());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  }, []);

  const signOut = useCallback(async () => {
    const fb = firebaseApp();
    if (fb) await fbSignOut(getAuth(fb));
  }, []);

  const can = useCallback((level: 'viewer' | 'sales' | 'admin') => (RANK[me?.role ?? 'pending'] ?? 0) >= RANK[level]!, [me]);

  return <AuthContext.Provider value={{ status, me, error, signIn, signOut, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
