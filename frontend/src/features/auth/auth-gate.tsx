import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/use-auth";
import { supabase } from "@/features/auth/supabase";
import { signInWithMonadWallet } from "@/features/auth/monad-wallet";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  if (userId) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setLoading(false);

    if (authError) {
      setError(authError.message);
    }
    // onAuthStateChange in useAuth will pick up SIGNED_IN and sync to backend
  };

  const handleOAuth = async (provider: "google" | "github") => {
    setLoading(true);
    setError(null);
    // skipBrowserRedirect: we open the system browser ourselves.
    // The deep-link handler in use-auth.ts picks up the callback
    // kawai://auth?code=<pkce> or kawai://auth#access_token=<jwt>.
    const { data, error: authError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: "kawai://auth",
        skipBrowserRedirect: true,
      },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    // Open in system browser (webview blocks third-party OAuth cookies)
    if (data?.url) await openUrl(data.url);
  };

  const handleMonadWallet = async () => {
    setLoading(true);
    setError(null);
    try {
      // Backend creates (or reuses) the device hot wallet, signs the SIWE
      // message in-process, and Supabase issues the session.
      await signInWithMonadWallet();
      // onAuthStateChange in use-auth picks up SIGNED_IN and syncs the
      // token to the backend (set_session → keychain).
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-6">
        <h1 className="text-center text-2xl font-semibold text-foreground">Welcome to Kawai</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Loading..." : mode === "signin" ? "Sign In" : "Sign Up"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-4 hover:text-primary"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
          >
            {mode === "signin" ? "Sign Up" : "Sign In"}
          </button>
        </p>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or continue with</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" type="button" onClick={() => handleOAuth("google")} disabled={loading}>
            Google
          </Button>
          <Button variant="outline" type="button" onClick={() => handleOAuth("github")} disabled={loading}>
            GitHub
          </Button>
        </div>

        <Button variant="outline" type="button" className="w-full" onClick={handleMonadWallet} disabled={loading}>
          EVM Wallet
        </Button>

        {(authError || error) && <p className="text-center text-sm text-destructive">{error ?? authError}</p>}
      </div>
    </main>
  );
}
