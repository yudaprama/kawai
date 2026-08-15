import { call } from "./api.js";

// Establish a session by handing a JWT to the backend for verification.
// Desktop/mobile: backend verifies and stores identity in Tauri State<Session>.
export async function setSession(token) {
  return call("set_session", { token });
}

export async function logout() {
  await call("logout");
}

// Requires an active session; throws if not signed in.
export async function whoami() {
  return call("whoami");
}
