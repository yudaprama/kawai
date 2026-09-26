import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shared/icon";
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
  const [showPassword, setShowPassword] = useState(false);

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
            name="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {!(mode === "signup" && codeSent) && (
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="pr-10"
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md transition-colors"
              >
                <Icon name={showPassword ? "eye-off" : "eye"} className="size-4" />
              </button>
            </div>
          )}
          {mode === "signup" && codeSent && (
            <Input
              inputMode="numeric"
              name="one-time-code"
              autoComplete="one-time-code"
              placeholder="6-digit code sent to your email"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Icon name="loader-circle" className="size-3.5 animate-spin" />}
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

        {(authError || error) && (
          <p className="text-destructive text-center text-sm" role="alert">
            {error ?? authError}
          </p>
        )}
      </div>
    </main>
  );
}
