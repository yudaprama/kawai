import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/use-auth";
import { call } from "@/lib/api";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
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
        await call("auth_sign_in", { email, password });
      } else if (!codeSent) {
        // Step 1: email a 6-digit code, then ask for it.
        await call("auth_send_code", { email });
        setCodeSent(true);
        setLoading(false);
        return;
      } else {
        // Step 2: verify the code, then create the account.
        await call("auth_verify_code", { email, code });
        await call("auth_sign_up", { email, password });
      }
      await refresh();
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
            {!(mode === "signup" && codeSent) && (
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}
            {mode === "signup" && codeSent && (
              <Input
                inputMode="numeric"
                placeholder="6-digit code sent to your email"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? "Loading..."
                : mode === "signin"
                  ? "Sign In"
                  : codeSent
                    ? "Verify & Create Account"
                    : "Send Code & Sign Up"}
            </Button>
          </form>

        {mode === "signup" && codeSent && (
          <p className="text-center text-sm text-muted-foreground">
            Didn&apos;t get the code?{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-primary"
              onClick={() => {
                setCodeSent(false);
                setCode("");
                setError(null);
              }}
            >
              Go back
            </button>
          </p>
        )}

        <p className="text-center text-sm text-muted-foreground">
            {mode === "signin" ? "Don't have an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-primary"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setCodeSent(false);
                setCode("");
                setError(null);
              }}
            >
              {mode === "signin" ? "Sign Up" : "Sign In"}
            </button>
        </p>

        {(authError || error) && <p className="text-center text-sm text-destructive">{error ?? authError}</p>}
      </div>
    </main>
  );
}
