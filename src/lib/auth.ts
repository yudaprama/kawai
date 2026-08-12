import { call } from "./api";

export interface UserInfo {
  userId: string;
}

// Establish a session by handing a JWT to the backend for verification.
//
// Desktop/mobile: backend verifies and stores the identity in Tauri
//   `State<Session>` (in-memory; TODO persist to OS keychain via
//   `tauri-plugin-stronghold` so it survives restarts).
// Web: backend sets an HttpOnly `kawai_session` cookie; the browser attaches
//   it automatically to every subsequent `/api/*` call including SSE. No token
//   is held in JS, so XSS cannot exfiltrate it.
//
// Provider-agnostic — any OIDC JWT works. To wire Clerk, for example:
//   import { useAuth } from "@clerk/clerk-react";
//   const { getToken } = useAuth();
//   await setSession((await getToken()) ?? "");
export async function setSession(token: string): Promise<UserInfo> {
  return call<UserInfo>("set_session", { token });
}

export async function logout(): Promise<void> {
  await call<void>("logout");
}

// Requires an active session; throws if not signed in. Use on mount to detect
// an existing session (cookie on web / in-memory on desktop-mobile).
export async function whoami(): Promise<UserInfo> {
  return call<UserInfo>("whoami");
}
