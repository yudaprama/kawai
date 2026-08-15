import { CLERK_PUBLISHABLE_KEY } from "./config.js";
import { call } from "./lib/api.js";
import { logout, setSession, whoami } from "./lib/auth.js";
import { streamOperation } from "./lib/stream.js";

// ---- Element refs ----
const $ = (s) => document.querySelector(s);

const authOut = $("#auth-out");
const authIn = $("#auth-in");
const backendUser = $("#backend-user");
const signInBtn = $("#sign-in-btn");
const signUpBtn = $("#sign-up-btn");
const signOutBtn = $("#sign-out-btn");

const greetForm = $("#greet-form");
const greetInput = $("#greet-input");
const greetMsg = $("#greet-msg");

const startBtn = $("#start-stream");
const stopBtn = $("#stop-stream");
const progress = $("#progress");
const streamLog = $("#stream-log");

const noteForm = $("#note-form");
const noteInput = $("#note-input");
const notesError = $("#notes-error");
const notesList = $("#notes-list");
const notesEmpty = $("#notes-empty");

// ---- State ----
let clerk;
let streamCtrl = null;
let backendUserId = null;

// ---- Auth ----
async function initClerk() {
  clerk = new window.Clerk(CLERK_PUBLISHABLE_KEY);
  await clerk.load();

  // Listen for auth changes
  clerk.addListener(({ user }) => {
    if (!user) {
      renderSignedOut();
    } else {
      syncSession();
    }
  });

  if (clerk.user) {
    syncSession();
  } else {
    // Check for existing backend session (cookie / in-memory)
    await tryRestoreSession();
  }
}

async function syncSession() {
  const token = await clerk.session?.getToken();
  if (!token) return;
  try {
    const u = await setSession(token);
    backendUserId = u.userId;
    renderSignedIn();
  } catch {
    // Backend unavailable; keep showing signed-out
  }
}

async function tryRestoreSession() {
  try {
    const u = await whoami();
    backendUserId = u.userId;
    renderSignedIn();
  } catch {
    renderSignedOut();
  }
}

function renderSignedOut() {
  authOut.hidden = false;
  authIn.hidden = true;
  backendUserId = null;
  notesList.innerHTML = "";
  notesEmpty.hidden = false;
}

function renderSignedIn() {
  authOut.hidden = true;
  authIn.hidden = false;
  backendUser.innerHTML = `backend user: <b>${backendUserId}</b>`;
  refreshNotes();
}

signInBtn.addEventListener("click", () => clerk.openSignIn({ modal: true }));
signUpBtn.addEventListener("click", () => clerk.openSignUp({ modal: true }));

signOutBtn.addEventListener("click", async () => {
  await clerk.signOut();
  await logout().catch(() => {});
  renderSignedOut();
});

// ---- Greet ----
greetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const msg = await call("greet", { name: greetInput.value });
    greetMsg.textContent = msg;
  } catch (err) {
    greetMsg.textContent = `Error: ${err.message}`;
  }
});

// ---- Streaming ----
startBtn.addEventListener("click", () => {
  streamLog.innerHTML = "";
  progress.hidden = false;
  progress.value = 0;

  const input = { events: 10, intervalMs: 500 };
  streamCtrl = streamOperation("generate_activity", input, {
    onEvent: (ev) => {
      if (ev.type === "started") {
        progress.max = ev.total;
        progress.value = 0;
      } else if (ev.type === "progress") {
        progress.value = ev.done;
        const li = document.createElement("li");
        li.textContent = `event ${ev.done}/${ev.total}`;
        streamLog.appendChild(li);
      }
    },
    onDone: () => {
      const li = document.createElement("li");
      li.textContent = "\u2705 finished";
      streamLog.appendChild(li);
      streamCtrl = null;
    },
    onError: (err) => {
      const li = document.createElement("li");
      li.textContent = `\u274c ${err.message}`;
      streamLog.appendChild(li);
      streamCtrl = null;
    },
  });
});

stopBtn.addEventListener("click", () => {
  streamCtrl?.cancel();
  streamCtrl = null;
});

// ---- Notes ----
async function refreshNotes() {
  notesError.hidden = true;
  try {
    const notes = await call("list_notes");
    notesList.innerHTML = notes
      .map((n) => `<li><span class="note-id">#${n.id}</span> ${n.body}</li>`)
      .join("");
    notesEmpty.hidden = notes.length > 0;
  } catch (err) {
    notesError.textContent = err.message;
    notesError.hidden = false;
  }
}

noteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  notesError.hidden = true;
  try {
    await call("create_note", { body: noteInput.value });
    noteInput.value = "";
    await refreshNotes();
  } catch (err) {
    notesError.textContent = err.message;
    notesError.hidden = false;
  }
});

// ---- Boot ----
document.addEventListener("DOMContentLoaded", () => {
  initClerk();
});
