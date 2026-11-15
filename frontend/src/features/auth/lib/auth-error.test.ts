import { describe, expect, it } from "vitest";
import { authErrorMessage } from "@/features/auth/lib/auth-error";

/** Stand-in for `t`: returns the key so assertions read as "which message". */
const t = (key: string) => key;

describe("authErrorMessage", () => {
  it("maps the backend's sign-in rejections to one message", () => {
    // `error_text` answers 401 with "incorrect password" and 404 with "no
    // account found for this email" — the form must not reveal which one.
    expect(authErrorMessage(t, "incorrect password")).toBe("auth.error.invalidCredentials");
    expect(authErrorMessage(t, "no account found for this email")).toBe("auth.error.invalidCredentials");
  });

  it("maps duplicate-email and weak-password answers", () => {
    expect(authErrorMessage(t, "an account with this email already exists")).toBe("auth.error.emailExists");
    expect(authErrorMessage(t, "password too weak (min 8 chars)")).toBe("auth.error.weakPassword");
  });

  it("maps transport failures to the network message", () => {
    expect(authErrorMessage(t, "auth server unreachable: error sending request for url")).toBe("auth.error.network");
    expect(authErrorMessage(t, "operation timed out")).toBe("auth.error.network");
  });

  it("passes an unrecognized message through unchanged", () => {
    expect(authErrorMessage(t, "session expired — sign in again")).toBe("session expired — sign in again");
  });
});
