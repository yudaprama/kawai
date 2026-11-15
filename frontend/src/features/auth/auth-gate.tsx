import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shared/icon";
import { LogoMark } from "@/components/shared/logo";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/use-auth";
import { authErrorMessage } from "@/features/auth/lib/auth-error";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText, type UserInfo } from "@/lib/api";
import { useState, useEffect, useRef } from "react";

type Mode = "signin" | "signup" | "forgot";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, authError, signIn, refresh, clearError } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [showPassword, setShowPassword] = useState(false);
  // One-line confirmation after a successful reset (shown back on signin).
  const [notice, setNotice] = useState<string | null>(null);

  // Switch modes; the code/waiting state resets, the typed email stays.
  // The password is dropped on the reset form and when leaving it: carrying
  // it into "forgot" pre-fills the NEW-password field with the old one (so
  // "Reset Password" re-sets the same password and looks like it worked), and
  // a still-on eye toggle would show it in clear. Sign-in ↔ sign-up keeps it.
  const goTo = (next: Mode) => {
    setMode(next);
    setCodeSent(false);
    setCode("");
    setError(null);
    if (next === "forgot" || mode === "forgot") {
      setPassword("");
      setShowPassword(false);
    }
    if (next !== "signin") setNotice(null);
  };

  // The mode a submit started in. A form switch while that request is in
  // flight must not write its step state into the NEW form (a late
  // `auth_send_code` answer used to jump "forgot" straight to its code step,
  // though no reset code was ever mailed).
  const modeRef = useRef<Mode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const emailRef = useRef<HTMLInputElement>(null);
  // The gate stays mounted for the whole session (it renders `children` while
  // signed in), so a sign-out must scrub what the previous account typed —
  // otherwise the next person finds their email pre-filled and their password
  // still in the field, one tap on the eye away.
  useEffect(() => {
    if (userId) return;
    setPassword("");
    setCode("");
    setShowPassword(false);
    setCodeSent(false);
    setError(null);
    emailRef.current?.focus();
  }, [userId]);

  if (userId) return <>{children}</>;

  /** Adopt the identity the auth op just returned, without a second
   *  `whoami` (that re-verifies the bearer over the network and left the
   *  button spinning for a whole extra round trip). */
  const adopt = async (info: UserInfo | undefined) => {
    if (info?.userId) signIn(info.userId);
    // The web build answers with the identity resolved from the session
    // cookie; if that came back empty, let `whoami` resolve it.
    else await refresh();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const submitMode = mode;
    const stale = () => modeRef.current !== submitMode;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (submitMode === "signin") {
        const info = await call<UserInfo>("auth_sign_in", { email, password });
        if (!stale()) await adopt(info);
      } else if (submitMode === "forgot") {
        // The reset code is generated, emailed, and verified by the WORKER —
        // the client only relays what the user typed.
        if (!codeSent) {
          await call("auth_reset_request", { email });
          if (!stale()) setCodeSent(true);
        } else {
          await call("auth_reset_confirm", { email, code, newPassword: password });
          if (stale()) return;
          clearError();
          goTo("signin");
          setNotice(t("auth.resetSuccess"));
        }
      } else if (!codeSent) {
        // Step 1: email a 6-digit code (generated and mailed by the app),
        // then ask for it.
        await call("auth_send_code", { email });
        if (!stale()) setCodeSent(true);
      } else {
        // Step 2: check the code locally, then create the account.
        await call("auth_verify_code", { email, code });
        try {
          const info = await call<UserInfo>("auth_sign_up", { email, password });
          if (!stale()) await adopt(info);
        } catch (signUpErr) {
          // `auth_verify_code` consumed the code on a match, so the account
          // step needs a NEW one: drop back to step 1 instead of leaving the
          // user on a code field that can only fail.
          if (stale()) return;
          setCodeSent(false);
          setCode("");
          setError(authErrorMessage(t, errText(signUpErr)));
        }
      }
    } catch (err) {
      if (!stale()) setError(authErrorMessage(t, errText(err)));
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
            ref={emailRef}
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
              // The worker/app side is a 6-digit numeric code; filtering here
              // keeps a pasted "123 456" or a stray letter from round-tripping
              // to a "code is invalid" that looks like a wrong code.
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
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
              disabled={loading}
              className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 disabled:pointer-events-none disabled:opacity-50"
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
              disabled={loading}
              className="text-foreground underline underline-offset-4 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
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
              disabled={loading}
              className="text-foreground underline underline-offset-4 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
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
              disabled={loading}
              className="text-foreground underline underline-offset-4 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
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
            {error ?? authErrorMessage(t, authError ?? "")}
          </p>
        )}
      </div>
    </main>
  );
}
