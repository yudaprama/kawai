import type { TranslationKey } from "@/lib/i18n";

/**
 * Map the backend's auth error text onto a localized message.
 *
 * The command wrappers surface plain strings — `error_text` in
 * `logic/local_auth.rs` ("incorrect password", "no account found for this
 * email", "an account with this email already exists") and
 * `transport_error` ("auth server unreachable: …"). Rendered raw they would
 * put English inside an Indonesian UI, and those four cases are exactly the
 * ones the form can explain better than the wire text. Anything unrecognized
 * passes through unchanged — a wrong guess is worse than the real detail.
 */
export function authErrorMessage(t: (key: TranslationKey) => string, raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("incorrect password") || s.includes("no account found")) {
    return t("auth.error.invalidCredentials");
  }
  if (s.includes("already exists") || s.includes("already registered")) {
    return t("auth.error.emailExists");
  }
  if (s.includes("password must not be empty") || s.includes("weak") || s.includes("at least")) {
    return t("auth.error.weakPassword");
  }
  if (
    s.includes("unreachable") ||
    s.includes("error sending request") ||
    s.includes("timed out") ||
    s.includes("timeout")
  ) {
    return t("auth.error.network");
  }
  return raw;
}
