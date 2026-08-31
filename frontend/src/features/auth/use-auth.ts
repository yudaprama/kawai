import { useCallback, useEffect, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import type { UserInfo } from "@/lib/api";
import { call, errText } from "@/lib/api";
import { supabase } from "@/features/auth/supabase";

/**
 * Parse a kawai://auth deep-link URL for auth tokens.
 * - PKCE:   ?code=<code>
 * - Direct: ?token=<jwt>
 * - Implicit (fragment): #access_token=<jwt>&...
 */
function parseAuthUrl(url: string): { code?: string; token?: string } | null {
  try {
    const u = new URL(url);
    const code = u.searchParams.get("code") ?? undefined;
    const token = u.searchParams.get("token") ?? undefined;
    if (code || token) return { code, token };
    // Implicit flow: tokens in hash fragment
    if (u.hash) {
      const params = new URLSearchParams(u.hash.slice(1));
      const accessToken = params.get("access_token");
      if (accessToken) return { token: accessToken };
    }
    return null;
  } catch {
    return null;
  }
}

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

    // Deep-link auth: kawai://auth?code=... or kawai://auth#access_token=...
    let unlistenDeepLink: (() => void) | undefined;

    const handleDeepLink = async (urls: string[]) => {
      for (const url of urls) {
        if (!url.startsWith("kawai://auth")) continue;
        const parsed = parseAuthUrl(url);
        if (!parsed) continue;

        if (parsed.code) {
          // PKCE code exchange — the verifier is stored in Supabase client storage
          // by signInWithOAuth({ skipBrowserRedirect: true }) before opening system browser.
          const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
          if (error) setAuthError(`OAuth failed: ${error.message}`);
          // onAuthStateChange handles SIGNED_IN → set_session
        } else if (parsed.token) {
          // Direct token (implicit flow fragment or manual ?token=)
          try {
            const u: UserInfo = await call<UserInfo>("set_session", { token: parsed.token });
            setUserId(u.userId);
            setAuthError(null);
          } catch (err) {
            setAuthError(errText(err));
          }
        }
      }
    };

    onOpenUrl(handleDeepLink).then((unlisten) => {
      unlistenDeepLink = unlisten;
    });
    // Cold start: app launched by deep link (URL arrived before listener registered)
    getCurrent().then((urls) => {
      if (urls?.length) void handleDeepLink(urls);
    });

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
      unlistenDeepLink?.();
    };
  }, [syncSession]);

  return { userId, authError, refresh: syncSession };
}
