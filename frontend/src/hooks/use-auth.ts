import { useCallback, useEffect, useState } from "react";
import type { UserInfo } from "@/lib/api";
import { call, errText } from "@/lib/api";
import { supabase } from "@/lib/supabase";

export function useAuth() {
  const [userId, setUserId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const syncSession = useCallback(async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        const u: UserInfo = await call<UserInfo>("set_session", { token: session.access_token });
        setUserId(u.userId);
        setAuthError(null);
        return;
      }
    } catch {
      // fall through to bootstrap
    }
    // No Supabase session — try backend bootstrap (whoami / restore_session)
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
    void syncSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.access_token) {
        try {
          const u: UserInfo = await call<UserInfo>("set_session", { token: session.access_token });
          setUserId(u.userId);
          setAuthError(null);
        } catch (err) {
          setAuthError(errText(err));
        }
      } else if (event === "SIGNED_OUT") {
        setUserId(null);
        setAuthError(null);
        // Tell the backend to clear its in-memory session
        try {
          await call("logout");
        } catch {
          // best-effort
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [syncSession]);

  return { userId, authError, refresh: syncSession };
}
