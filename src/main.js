import "./lib/log.js";
import { call } from "./lib/api.js";
import { logout as backendLogout, setSession, whoami } from "./lib/auth.js";
import { streamOperation } from "./lib/stream.js";

let clerk;

// ---- Stream / chat controllers (not reactive) ----
let streamCtrl = null;
let chatCtrl = null;

// ---- Alpine store ----
// Register defensively: if main.js runs after Alpine (script order changed,
// bundler, etc.) the alpine:init event has already fired — register directly.
function registerStore() {
  Alpine.store("app", {
    userId: null,
    clerkError: "",
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
      modelPreset: "",
      modelPath: "",
      backend: "cpu",
      specDec: false,
      modelStatus: "",
      modelError: false,
      modelLoaded: false,
      loading: false,
      messages: [],
      chatInput: "",
      chatActive: false,
      stats: "",
      thinking: false,
      pendingImage: null,
      pendingImageName: "",
    },
  });
}

if (window.Alpine) {
  registerStore();
} else {
  document.addEventListener("alpine:init", registerStore, { once: true });
}

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

function errText(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

async function loadModel() {
  const llm = Alpine.store("app").llm;
  const path = llm.modelPreset === "custom" ? llm.modelPath.trim() : llm.modelPreset;
  if (!path) return;
  llm.loading = true;
  llm.modelError = false;
  llm.modelStatus = `Loading ${path} …`;
  try {
    const info = await call("local_load_model", {
      modelPath: path,
      gpu: llm.backend === "gpu",
      speculativeDecoding: llm.specDec,
    });
    llm.modelStatus = `\u2714 ${info.modelPath.split("/").pop()} [${info.backend}]`;
    llm.modelLoaded = true;
    llm.messages = [];
    llm.stats = "";
  } catch (err) {
    llm.modelStatus = `Error: ${errText(err)}`;
    console.error("[loadModel]", errText(err)); // → frontend_log → app.log
    llm.modelError = true;
    llm.modelLoaded = false;
  } finally {
    llm.loading = false;
  }
}

function scrollChat() {
  const el = document.getElementById("local-chat-log");
  if (el) el.scrollTop = el.scrollHeight;
}

function chat() {
  const llm = Alpine.store("app").llm;
  const prompt = llm.chatInput.trim();
  if (!prompt || llm.chatActive) return;
  const image = llm.pendingImage;
  llm.chatInput = "";
  llm.pendingImage = null;
  llm.pendingImageName = "";
  llm.messages = [
    ...llm.messages,
    { role: "user", text: prompt, hasImage: !!image },
    { role: "assistant", text: "" },
  ];
  llm.chatActive = true;
  scrollChat();

  const t0 = performance.now();
  let chunks = 0;
  let chars = 0;
  const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

  chatCtrl = streamOperation("local_chat", { prompt, image: image || null }, {
    onEvent: (ev) => {
      if (ev.type === "token") {
        chunks += 1;
        chars += ev.text.length;
        const msgs = llm.messages.slice();
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], text: msgs[msgs.length - 1].text + ev.text };
        llm.messages = msgs;
        llm.stats = `${chunks} chunks · ${chars} chars · ${elapsed()}`;
        scrollChat();
      }
    },
    onDone: () => {
      llm.stats = `done · ${chunks} chunks · ${chars} chars · ${elapsed()}`;
      llm.chatActive = false;
      chatCtrl = null;
    },
    onError: (err) => {
      llm.messages = [...llm.messages, { role: "error", text: err.message }];
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

function pickImage() {
  document.getElementById("image-input").click();
}

function onImageSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(",")[1];
    Alpine.store("app").llm.pendingImage = base64;
    Alpine.store("app").llm.pendingImageName = file.name;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}

function clearImage() {
  Alpine.store("app").llm.pendingImage = null;
  Alpine.store("app").llm.pendingImageName = "";
}

async function resetChat() {
  const llm = Alpine.store("app").llm;
  if (llm.chatActive) return;
  try {
    await call("local_llm_reset");
    llm.messages = [];
    llm.stats = "";
  } catch (err) {
    console.error("[resetChat]", errText(err));
  }
}

async function toggleThinking() {
  const llm = Alpine.store("app").llm;
  llm.thinking = !llm.thinking;
  try {
    await call("local_llm_set_thinking", { enabled: llm.thinking });
  } catch (err) {
    console.error("[toggleThinking]", errText(err));
    llm.thinking = !llm.thinking;
  }
}

async function unloadModel() {
  const llm = Alpine.store("app").llm;
  if (llm.chatActive) return;
  try {
    await call("local_llm_unload");
    llm.modelLoaded = false;
    llm.modelStatus = "";
    llm.messages = [];
    llm.stats = "";
    llm.thinking = false;
  } catch (err) {
    console.error("[unloadModel]", errText(err));
  }
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
// clerk-js v5 browser build: `window.Clerk` is already an instance (not a
// constructor); the publishable key comes from the
// `data-clerk-publishable-key` attribute on the CDN script tag.
async function initClerk() {
  if (!window.Clerk) {
    Alpine.store("app").clerkError =
      "Clerk failed to load (CDN unreachable?) — using dev session.";
    tryRestoreSession();
    return;
  }
  clerk = window.Clerk;
  try {
    await clerk.load();
  } catch (err) {
    console.error("[clerk.load]", errText(err));
    Alpine.store("app").clerkError = "Clerk unavailable — using dev session.";
  }

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
  const app = Alpine.store("app");
  try {
    const u = await whoami();
    app.userId = u.userId;
    return;
  } catch {
    // No session yet. If the backend runs with the dev bypass
    // (KAWAI_AUTH_DEV_USER_ID), any token verifies — establish one so the
    // app is usable when Clerk cannot load (e.g. webview cookie isolation).
    // In production (no bypass) this call is simply rejected.
    try {
      const u = await setSession("dev-clerk-unavailable");
      app.userId = u.userId;
    } catch {
      app.userId = null;
    }
  }
}

// ---- Boot ----
document.addEventListener("DOMContentLoaded", () => {
  initClerk();
});

// Module scope is not visible to Alpine expressions — expose the actions.
Object.assign(window, {
  openSignIn: () => clerk?.openSignIn({ modal: true }),
  openSignUp: () => clerk?.openSignUp({ modal: true }),
  signOut,
  greet,
  startStream,
  stopStream,
  loadModel,
  chat,
  stopChat,
  resetChat,
  toggleThinking,
  unloadModel,
  pickImage,
  onImageSelected,
  clearImage,
  addNote,
});
