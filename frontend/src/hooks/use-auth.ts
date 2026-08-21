import { useCallback, useEffect, useState } from "react";
import { call, errText } from "@/lib/api";
import type { UserInfo } from "@/lib/api";

export function useAuth() {
  const [userId, setUserId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    setIsLoading(true);
    try {
      const u: UserInfo = await call<UserInfo>("whoami");
      setUserId(u.userId);
      setAuthError(null);
    } catch {
      try {
        const u: UserInfo = await call<UserInfo>(
          "set_session",
          { token: "dev-clerk-unavailable" },
        );
        setUserId(u.userId);
        setAuthError(null);
      } catch (err) {
        setAuthError(errText(err));
      }
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void bootstrap();
    return () => {};
  }, [bootstrap]);

  return { userId, authError, isLoading, refresh: bootstrap };
}