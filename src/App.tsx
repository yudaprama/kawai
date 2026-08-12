import { SignInButton, SignUpButton, UserButton, useAuth } from "@clerk/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { call } from "./lib/api";
import { logout, setSession, type UserInfo } from "./lib/auth";
import { type StreamController, streamOperation } from "./lib/stream";
import { type ActivityEvent, type ActivityInput, type Note } from "./types/events";

export default function App() {
  const { isSignedIn, getToken } = useAuth();
  const [backendUser, setBackendUser] = useState<UserInfo | null>(null);

  const [name, setName] = useState("");
  const [greetMsg, setGreetMsg] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [log, setLog] = useState<string[]>([]);
  const streamRef = useRef<StreamController | null>(null);

  const [noteDraft, setNoteDraft] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesError, setNotesError] = useState("");

  // Push Clerk's (short-lived) session JWT into the backend so backend ops can
  // verify identity:
  //   - Web: backend sets an HttpOnly cookie (browser auto-attaches to /api/*).
  //   - Desktop/mobile: backend stores it in Tauri `State<Session>`.
  // Refreshed before the ~60s token expiry. The UI's source of truth for auth
  // state is Clerk (`isSignedIn`); `backendUser` is shown only to confirm that
  // backend verification against Clerk's JWKS succeeded.
  useEffect(() => {
    if (!isSignedIn) {
      setBackendUser(null);
      logout().catch(() => {});
      return;
    }
    let cancelled = false;
    const sync = async () => {
      const token = await getToken();
      if (!token || cancelled) return;
      try {
        const u = await setSession(token);
        if (!cancelled) setBackendUser(u);
      } catch {
        // Backend unavailable or token unverifiable; UI stays signed in.
      }
    };
    void sync();
    const id = setInterval(sync, 50_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isSignedIn, getToken]);

  // Load the signed-in user's notes once the backend session is established.
  useEffect(() => {
    if (isSignedIn && backendUser) void refreshNotes();
    if (!isSignedIn) setNotes([]);
  }, [isSignedIn, backendUser]);

  async function onGreet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const msg = await call<string>("greet", { name });
    setGreetMsg(msg);
  }

  async function refreshNotes() {
    setNotesError("");
    try {
      setNotes(await call<Note[]>("list_notes"));
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNotesError("");
    try {
      await call<Note>("create_note", { body: noteDraft });
      setNoteDraft("");
      await refreshNotes();
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : String(err));
    }
  }

  function startStream() {
    setLog([]);
    setProgress(null);
    const input: ActivityInput = { events: 10, intervalMs: 500 };
    streamRef.current = streamOperation<ActivityEvent>(
      "generate_activity",
      input as unknown as Record<string, unknown>,
      {
        onEvent: (ev) => {
          if (ev.type === "started") {
            setProgress({ done: 0, total: ev.total });
          } else if (ev.type === "progress") {
            setProgress({ done: ev.done, total: ev.total });
            setLog((l) => [...l, `event ${ev.done}/${ev.total}`]);
          }
        },
        onDone: () => setLog((l) => [...l, "✅ finished"]),
        onError: (err) => setLog((l) => [...l, `❌ ${err.message}`]),
      },
    );
  }

  function stopStream() {
    streamRef.current?.cancel();
    streamRef.current = null;
  }

  return (
    <main className="container mx-auto max-w-2xl space-y-8 p-8">
      <h1 className="text-2xl font-bold">Kawai</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Auth (Clerk)</h2>
        {isSignedIn ? (
          <div className="flex items-center gap-3 text-sm">
            <UserButton />
            {backendUser && (
              <span>
                backend user:{" "}
                <b className="font-mono">{backendUser.userId}</b>
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-sm">Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="btn btn-ghost btn-sm">Sign up</button>
            </SignUpButton>
          </div>
        )}
      </section>

      <hr />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">RPC (request-response)</h2>
        <form className="flex gap-2" onSubmit={onGreet}>
          <input
            className="input input-bordered flex-1"
            placeholder="Enter a name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Greet
          </button>
        </form>
        {greetMsg && <p className="text-sm">{greetMsg}</p>}
      </section>

      <hr />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Streaming</h2>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={startStream}>
            Start stream
          </button>
          <button className="btn btn-ghost" onClick={stopStream}>
            Stop
          </button>
        </div>
        {progress && (
          <progress
            className="progress progress-primary w-full"
            max={progress.total}
            value={progress.done}
          />
        )}
        <ul className="font-mono text-xs">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>

      <hr />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Notes (per-user, sqld)</h2>
        {isSignedIn ? (
          <>
            <form className="flex gap-2" onSubmit={onCreateNote}>
              <input
                className="input input-bordered flex-1"
                placeholder="Write a note..."
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
              <button className="btn btn-primary" type="submit">
                Add
              </button>
            </form>
            {notesError && <p className="text-xs text-error">{notesError}</p>}
            <ul className="space-y-1 text-sm">
              {notes.map((n) => (
                <li key={n.id} className="font-mono">
                  <span className="opacity-50">#{n.id}</span> {n.body}
                </li>
              ))}
              {notes.length === 0 && (
                <li className="text-xs opacity-60">No notes yet.</li>
              )}
            </ul>
          </>
        ) : (
          <p className="text-xs opacity-60">Sign in to use notes.</p>
        )}
      </section>
    </main>
  );
}
