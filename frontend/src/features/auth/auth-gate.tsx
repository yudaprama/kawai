import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/use-auth";
import { call } from "@/lib/api";
import { signInWithMonadWallet } from "@/features/auth/monad-wallet";
import { supabase } from "@/features/auth/supabase";

async function finishSupabaseAuth(result: { data: { session: { access_token: string } | null }; error: { message: string } | null }) {
  if (result.error) throw new Error(result.error.message);
  if (!result.data.session) throw new Error("Check your email to confirm your account, then sign in.");
  await call("set_session", { token: result.data.session.access_token });
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError, refresh } = useAuth();
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
    try {
      if (mode === "signin") {
        await finishSupabaseAuth(await supabase.auth.signInWithPassword({ email, password }));
      } else {
        await finishSupabaseAuth(await supabase.auth.signUp({ email, password }));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleMonadWallet = async () => {
    setLoading(true);
    setError(null);
    try {
      // Backend creates (or reuses) the device hot wallet, signs the SIWE
      // message in-process, and Supabase issues the session.
      await signInWithMonadWallet();
      // onAuthStateChange in use-auth picks up SIGNED_IN and syncs to the
      // backend (set_session → keychain).
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
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
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

        <Button variant="outline" type="button" className="w-full" onClick={handleMonadWallet} disabled={loading}>
          EVM Wallet
        </Button>

        {(authError || error) && <p className="text-center text-sm text-destructive">{error ?? authError}</p>}
      </div>
    </main>
  );
}
