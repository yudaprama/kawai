import { useCallback, useEffect, useState } from "react";
import type { UserInfo } from "@/lib/api";
import { call, errText } from "@/lib/api";

export function useAuth() {
  const [userId, setUserId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Bootstrap: ask the backend whether a session is still alive (in-memory
  // only — after an app restart the user signs in again).
  const syncSession = useCallback(async () => {
    try {
      const u: UserInfo = await call<UserInfo>("whoami");
      setUserId(u.userId);
      setAuthError(null);
    } catch (err) {
      setUserId(null);
      const message = errText(err);
      // "not authenticated" just means no live session — the normal signed-out
      // state, not an error to surface above the sign-in form.
      setAuthError(message.toLowerCase().includes("not authenticated") ? null : message);
    }
  }, []);

  useEffect(() => {
    void syncSession();
  }, [syncSession]);

  const logout = useCallback(async () => {
    try {
      await call("logout");
    } catch {
      // best-effort
    }
    setUserId(null);
    setAuthError(null);
  }, []);

  return { userId, authError, refresh: syncSession, logout };
}
