import { CLERK_PUBLISHABLE_KEY } from "./config.js";
import { call } from "./lib/api.js";
import { logout as backendLogout, setSession, whoami } from "./lib/auth.js";
import { streamOperation } from "./lib/stream.js";

let clerk;

// ---- Stream / chat controllers (not reactive) ----
let streamCtrl = null;
let chatCtrl = null;

// ---- Alpine store ----
document.addEventListener("alpine:init", () => {
  Alpine.store("app", {
    userId: null,
    greetInput: "",
    greetMsg: "",
    greetError: false,
    stream: {
      active: false,
      done: 0,
      total: 10,
      log: [],
    },
    notes: [],
    notesError: "",
    noteInput: "",
    llm: {
      modelPath: "",
      modelStatus: "",
      modelError: false,
      modelLoaded: false,
      chatInput: "",
      chatOutput: "",
      chatActive: false,
    },
  });
});

// ---- Actions exposed to Alpine ----
async function signOut() {
  await clerk.signOut();
  await backendLogout().catch(() => {});
  Alpine.store("app").userId = null;
}

async function greet() {
  const app = Alpine.store("app");
  app.greetError = false;
  try {
    app.greetMsg = await call("greet", { name: app.greetInput });
  } catch (err) {
    app.greetMsg = `Error: ${err.message}`;
    app.greetError = true;
  }
}

function startStream() {
  const app = Alpine.store("app");
  app.stream.log = [];
  app.stream.active = true;
  app.stream.done = 0;

  const input = { events: 10, intervalMs: 500 };
  streamCtrl = streamOperation("generate_activity", input, {
    onEvent: (ev) => {
      if (ev.type === "started") {
        app.stream.total = ev.total;
        app.stream.done = 0;
      } else if (ev.type === "progress") {
        app.stream.done = ev.done;
        app.stream.log = [...app.stream.log, `event ${ev.done}/${ev.total}`];
      }
    },
    onDone: () => {
      app.stream.log = [...app.stream.log, "\u2705 finished"];
      app.stream.active = false;
      streamCtrl = null;
    },
    onError: (err) => {
      app.stream.log = [...app.stream.log, `\u274c ${err.message}`];
      app.stream.active = false;
      streamCtrl = null;
    },
  });
}

function stopStream() {
  streamCtrl?.cancel();
  streamCtrl = null;
  Alpine.store("app").stream.active = false;
}

async function loadModel() {
  const app = Alpine.store("app");
  const llm = app.llm;
  llm.modelError = false;
  llm.modelStatus = "Loading model...";
  try {
    const info = await call("local_load_model", {
      modelPath: llm.modelPath.trim(),
      gpu: true,
    });
    llm.modelStatus = `Loaded ${info.modelPath} (${info.backend})`;
    llm.modelLoaded = true;
  } catch (err) {
    llm.modelStatus = `Error: ${err.message}`;
    llm.modelError = true;
  }
}

function chat() {
  const app = Alpine.store("app");
  const llm = app.llm;
  const prompt = llm.chatInput.trim();
  if (!prompt) return;
  llm.chatInput = "";
  llm.chatOutput = "";
  llm.chatActive = true;

  chatCtrl = streamOperation("local_chat", { prompt }, {
    onEvent: (ev) => {
      if (ev.type === "token") {
        llm.chatOutput += ev.text;
      }
    },
    onDone: () => {
      llm.chatActive = false;
      chatCtrl = null;
    },
    onError: (err) => {
      llm.chatOutput += `\n[error] ${err.message}`;
      llm.chatActive = false;
      chatCtrl = null;
    },
  });
}

function stopChat() {
  chatCtrl?.cancel();
  chatCtrl = null;
  Alpine.store("app").llm.chatActive = false;
}

async function addNote() {
  const app = Alpine.store("app");
  app.notesError = "";
  try {
    await call("create_note", { body: app.noteInput });
    app.noteInput = "";
    await refreshNotes();
  } catch (err) {
    app.notesError = err.message;
  }
}

async function refreshNotes() {
  const app = Alpine.store("app");
  try {
    app.notes = await call("list_notes");
  } catch (err) {
    app.notesError = err.message;
  }
}

// ---- Clerk auth ----
async function initClerk() {
  clerk = new window.Clerk(CLERK_PUBLISHABLE_KEY);
  await clerk.load();

  clerk.addListener(({ user }) => {
    if (!user) {
      Alpine.store("app").userId = null;
    } else {
      syncSession();
    }
  });

  if (clerk.user) {
    syncSession();
  } else {
    await tryRestoreSession();
  }
}

async function syncSession() {
  const token = await clerk.session?.getToken();
  if (!token) return;
  try {
    const u = await setSession(token);
    Alpine.store("app").userId = u.userId;
  } catch {
    Alpine.store("app").userId = null;
  }
}

async function tryRestoreSession() {
  try {
    const u = await whoami();
    Alpine.store("app").userId = u.userId;
  } catch {
    Alpine.store("app").userId = null;
  }
}

// ---- Boot ----
document.addEventListener("DOMContentLoaded", () => {
  initClerk();
});
