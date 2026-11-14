import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shared/icon";
import { LogoMark } from "@/components/shared/logo";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { call } from "@/lib/api";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError, refresh } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [showPassword, setShowPassword] = useState(false);
  // One-line confirmation after a successful reset (shown back on signin).
  const [notice, setNotice] = useState<string | null>(null);

  // Switch modes; the code/waiting state resets, the typed email stays.
  const goTo = (next: "signin" | "signup" | "forgot") => {
    setMode(next);
    setCodeSent(false);
    setCode("");
    setError(null);
    if (next !== "signin") setNotice(null);
  };

  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!userId) emailRef.current?.focus();
  }, [userId]);

  if (userId) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "signin") {
        await call("auth_sign_in", { email, password });
      } else if (mode === "forgot") {
        // The reset code is generated, emailed, and verified by the WORKER —
        // the client only relays what the user typed.
        if (!codeSent) {
          await call("auth_reset_request", { email });
          setCodeSent(true);
          setLoading(false);
          return;
        }
        await call("auth_reset_confirm", { email, code, newPassword: password });
        goTo("signin");
        setNotice(t("auth.resetSuccess"));
        setLoading(false);
        return;
      } else if (!codeSent) {
        // Step 1: email a 6-digit code (generated and mailed by the app),
        // then ask for it.
        await call("auth_send_code", { email });
        setCodeSent(true);
        setLoading(false);
        return;
      } else {
        // Step 2: check the code locally, then create the account.
        await call("auth_verify_code", { email, code });
        try {
          await call("auth_sign_up", { email, password });
        } catch (signUpErr) {
          // Keep code valid, offer "Sign in instead"

          setError(signUpErr instanceof Error ? signUpErr.message : String(signUpErr));
          setLoading(false);
          return;
        }
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    // min-h-dvh + overflow-y-auto + `my-auto` on the child: with the IME up
    // the viewport shrinks (adjustResize), and this still centers on short
    // screens while staying scrollable when the form is taller than the view.
    <main className="safe-t safe-b flex min-h-dvh items-center justify-center overflow-y-auto bg-background p-6">
      <div className="my-auto w-full max-w-md space-y-6">
        <LogoMark className="text-brand mx-auto size-16" />
        <h1 className="text-center text-2xl font-semibold text-foreground">{t("auth.welcome")}</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="email"
            name="email"
            autoComplete="email"
            placeholder={t("auth.email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {!(mode === "signup" && codeSent) && !(mode === "forgot" && !codeSent) && (
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                placeholder={mode === "forgot" ? t("auth.newPassword") : t("auth.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="pr-10"
              />
              <button
                type="button"
                aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                aria-pressed={showPassword}
                title={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                onClick={() => setShowPassword((v) => !v)}
                className="text-muted-foreground hover:text-foreground hit-44 absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md transition-colors"
              >
                <Icon name={showPassword ? "eye-off" : "eye"} className="size-4" />
              </button>
            </div>
          )}
          {mode !== "signin" && codeSent && (
            <Input
              inputMode="numeric"
              name="one-time-code"
              autoComplete="one-time-code"
              placeholder={t("auth.codePlaceholder")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Icon name="loader-circle" className="size-3.5 animate-spin" />}
            {loading
              ? t("common.loading")
              : mode === "forgot"
                ? codeSent
                  ? t("auth.resetConfirmButton")
                  : t("auth.sendResetCodeButton")
                : mode === "signin"
                  ? t("auth.signInButton")
                  : codeSent
                    ? t("auth.verifyAndCreateButton")
                    : t("auth.sendCodeSignUpButton")}
          </Button>
        </form>

        {mode === "signin" && (
          <p className="text-center">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
              onClick={() => goTo("forgot")}
            >
              {t("auth.forgotPassword")}
            </button>
          </p>
        )}

        {mode !== "signin" && codeSent && (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth.didntGetCode")}{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-primary"
              onClick={() => goTo(mode)}
            >
              {t("common.back")}
            </button>
          </p>
        )}

        {mode === "forgot" ? (
          <p className="text-center text-sm text-muted-foreground">
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-primary"
              onClick={() => goTo("signin")}
            >
              {t("auth.signIn")}
            </button>
          </p>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {mode === "signin" ? t("auth.noAccount") : t("auth.hasAccount")}{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-primary"
              onClick={() => goTo(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? t("auth.signUp") : t("auth.signIn")}
            </button>
          </p>
        )}

        {notice && (
          <p className="text-success text-center text-sm" role="status">
            {notice}
          </p>
        )}

        {(authError || error) && (
          <p className="text-destructive text-center text-sm" role="alert">
            {error ?? authError}
          </p>
        )}
      </div>
    </main>
  );
}
