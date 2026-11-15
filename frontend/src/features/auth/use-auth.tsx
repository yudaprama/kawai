import type { UserInfo } from "@/lib/api";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { call, errText } from "@/lib/api";

export interface AuthApi {
  userId: string | null;
  authError: string | null;
  /** Adopt an identity the backend already verified. `auth_sign_in` /
   *  `auth_sign_up` answer with the user record, so the gate does not need a
   *  second `whoami` round trip (which re-verifies the bearer over the
   *  network) to leave the form. */
  signIn: (userId: string) => void;
  /** Re-ask the backend whether the stored session is still alive. */
  refresh: () => Promise<void>;
  clearError: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

/**
 * The app's ONE auth store. Consumers must share this instance: the gate that
 * decides whether the signed-in tree renders and the shell that signs out are
 * two different components, and an independent `useState` per consumer left
 * the gate believing it was still signed in after a sign-out (the app then
 * kept rendering with every op failing `not authenticated`).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // Bumped by every identity change. A `whoami` already in flight when that
  // happens is stale: its answer describes the PREVIOUS session, and applying
  // it would drop a freshly signed-in user back onto the form.
  const epoch = useRef(0);

  // Bootstrap: ask the backend whether a session is still alive (desktop
  // restores the persisted bearer at launch, so this can land on the app).
  const refresh = useCallback(async () => {
    const started = ++epoch.current;
    try {
      const u: UserInfo = await call<UserInfo>("whoami");
      if (epoch.current !== started) return;
      setUserId(u.userId);
      setAuthError(null);
    } catch (err) {
      if (epoch.current !== started) return;
      setUserId(null);
      const message = errText(err);
      // "not authenticated" just means no live session — the normal signed-out
      // state, not an error to surface above the sign-in form.
      setAuthError(message.toLowerCase().includes("not authenticated") ? null : message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback((id: string) => {
    epoch.current += 1;
    setUserId(id);
    setAuthError(null);
  }, []);

  const clearError = useCallback(() => setAuthError(null), []);

  const logout = useCallback(async () => {
    epoch.current += 1;
    try {
      await call("logout");
    } catch {
      // best-effort
    }
    setUserId(null);
    setAuthError(null);
  }, []);

  const value = useMemo<AuthApi>(
    () => ({ userId, authError, signIn, refresh, clearError, logout }),
    [userId, authError, signIn, refresh, clearError, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
