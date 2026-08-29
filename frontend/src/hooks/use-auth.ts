import { useAuth as useClerkAuth } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import type { UserInfo } from "@/lib/api";
import { call, errText } from "@/lib/api";

export function useAuth() {
  const { isSignedIn, getToken } = useClerkAuth();
  const [userId, setUserId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    try {
      const u: UserInfo = await call<UserInfo>("whoami");
      setUserId(u.userId);
      setAuthError(null);
    } catch {
      try {
        const u: UserInfo = await call<UserInfo>("restore_session");
        setUserId(u.userId);
        setAuthError(null);
      } catch (err) {
        setUserId(null);
        setAuthError(errText(err));
      }
    }
  }, []);

  useEffect(() => {
    if (isSignedIn) {
      void getToken().then((token) => {
        if (token)
          void call<UserInfo>("set_session", { token })
            .then((u) => setUserId(u.userId))
            .catch((err) => setAuthError(errText(err)));
      });
    }
    void bootstrap();
    return () => {};
  }, [bootstrap, getToken, isSignedIn]);

  return { userId, authError, refresh: bootstrap };
}
