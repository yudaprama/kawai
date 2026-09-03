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
      setAuthError(errText(err));
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
