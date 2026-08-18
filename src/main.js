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
    sessions: [],
    agents: [
      { id: "office", name: "Office", icon: "i-briefcase", subtitle: "docs \u00b7 pdf \u00b7 sheets", description: "Documents, PDFs, spreadsheets \u2014 created and edited locally", prompts: ["Summarize this PDF", "Create a weekly report", "Merge these invoices"] },
      { id: "finance", name: "Finance", icon: "i-line-chart", subtitle: "markets & budgets", description: "Markets, budgets, and financial analysis", prompts: ["Analyze my portfolio", "Create a budget", "Compare Q3 vs Q2"] },
      { id: "knowledge", name: "Knowledge", icon: "i-book-open", subtitle: "notes & recall", description: "Notes, research, and knowledge recall", prompts: ["Search my notes", "Create a research brief", "Summarize this article"] },
      { id: "weather", name: "Weather", icon: "i-cloud-sun", subtitle: "forecasts & alerts", description: "Forecasts, alerts, and weather insights", prompts: ["Weekend forecast", "Rain alert for commute", "Best travel days"] },
    ],
    get sessionGroups() {
      const ctx = window.PineconeRouter?.context;
      const agentId = ctx?.params?.agentId;
      const filtered = agentId ? this.sessions.filter(s => s.agentId === agentId) : this.sessions;
      const groups = {};
      filtered.forEach(s => {
        const period = s.createdAt ? sessionPeriod(s.createdAt) : "Earlier";
        if (!groups[period]) groups[period] = [];
        groups[period].push(s);
      });
      return ["Today", "Yesterday", "Earlier"].filter(k => groups[k]).map(k => ({ label: k, sessions: groups[k] }));
    },
    createSession() {
      const ctx = window.PineconeRouter?.context;
      const agentId = ctx?.params?.agentId || "office";
      createSessionForAgent(agentId);
    },
    llm: {
      modelPreset: "",
      modelPath: "",
      backend: "cpu",
      specDec: false,
      modelStatus: "",
      modelError: false,
      modelLoaded: false,
      loading: false,
      sessionId: null,
      messages: [],
      chatInput: "",
      chatActive: false,
      stats: "",
      thinking: false,
      pendingImage: null,
      pendingImageName: "",
      pendingAudio: null,
      pendingAudioName: "",
      recording: false,
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

function sessionPeriod(createdAt) {
  const now = new Date();
  const d = new Date(createdAt * 1000);
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return "Earlier";
}

// Prompt chip click: create a fresh session for the current agent, navigate to
// it, and prefill the composer with the prompt.
async function promptChip(prompt) {
  const app = Alpine.store("app");
  const llm = app.llm;
  if (llm.chatActive) return;
  const ctx = window.PineconeRouter?.context;
  const agentId = ctx?.params?.agentId || "office";
  try {
    const s = await call("create_chat_session", { agentId });
    await loadSessions();
    llm.sessionId = s.id;
    llm.chatInput = prompt;
    window.PineconeRouter.navigate("/" + agentId + "/" + s.id);
  } catch (err) {
    console.error("[promptChip]", errText(err));
  }
}

async function createSessionForAgent(agentId) {
  const llm = Alpine.store("app").llm;
  if (llm.chatActive) return;
  try {
    const s = await call("create_chat_session", { agentId });
    await loadSessions();
    window.PineconeRouter.navigate("/" + agentId + "/" + s.id);
  } catch (err) {
    console.error("[createSessionForAgent]", errText(err));
  }
}

async function loadModel() {
  const llm = Alpine.store("app").llm;
  const path = llm.modelPreset === "custom" ? llm.modelPath.trim() : llm.modelPreset;
  if (!path) return;
  llm.loading = true;
  llm.modelError = false;
  llm.modelStatus = `Loading ${path} …`;
  try {
    // Get rig-components tools for native function calling
    let toolsJson = null;
    try {
      toolsJson = await call("local_llm_get_rig_tools", {
        toolNames: ["get_weather", "get_stock_quote", "get_crypto_price"],
      });
    } catch (e) {
      console.log("[loadModel] No rig-tools available:", e);
    }
    
    const info = await call("local_load_model", {
      modelPath: path,
      gpu: llm.backend === "gpu",
      speculativeDecoding: llm.specDec,
      toolsJson: toolsJson,
    });
    llm.modelStatus = `\u2714 ${info.modelPath.split("/").pop()} [${info.backend}]`;
    llm.modelLoaded = true;
    llm.messages = [];
    llm.stats = "";
    await loadChatHistory();
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

// Chat persistence (local SQLite, agent-ready sessions/messages schema). Reload the
// most recent session after a model load; failures are non-fatal — chat works
// without persistence, it just won't survive a restart.
async function loadChatHistory() {
  const llm = Alpine.store("app").llm;
  try {
    await loadSessions();
    const app = Alpine.store("app");
    const ctx = window.PineconeRouter?.context;
    // If we're on a session route, load that session; otherwise load the latest.
    const routeSessionId = ctx?.params?.sessionId;
    let target = null;
    if (routeSessionId) {
      target = app.sessions.find(s => String(s.id) === routeSessionId) || null;
    }
    if (!target) {
      target = app.sessions[0] || null;
    }
    llm.sessionId = target ? target.id : null;
    const messages = target ? await call("list_chat_messages", { sessionId: target.id }) : [];
    llm.messages = messages.map((m) => ({ role: m.role, text: m.content, toolCalls: [] }));
    scrollChat();
  } catch (err) {
    llm.sessionId = null;
    console.error("[loadChatHistory]", errText(err));
  }
}

// Load all sessions from the database (newest first).
async function loadSessions() {
  const app = Alpine.store("app");
  try {
    app.sessions = await call("list_chat_sessions");
  } catch (err) {
    app.sessions = [];
    console.error("[loadSessions]", errText(err));
  }
}

// Switch to a different session. Clears the Conversation API history (model
// context starts fresh) and loads the selected session's messages from local SQLite.
async function switchSession(sessionId) {
  const llm = Alpine.store("app").llm;
  if (llm.chatActive) return;
  if (sessionId === llm.sessionId) return;

  // Clear model context — the Conversation API doesn't support multi-session.
  try {
    await call("local_llm_reset");
  } catch (err) {
    console.error("[switchSession] reset", errText(err));
  }

  // Load the selected session's messages from local SQLite.
  llm.sessionId = sessionId;
  try {
    const messages = sessionId
      ? await call("list_chat_messages", { sessionId })
      : [];
    llm.messages = messages.map((m) => ({ role: m.role, text: m.content, toolCalls: [] }));
  } catch (err) {
    llm.messages = [];
    console.error("[switchSession] load messages", errText(err));
  }
  llm.stats = "";
  scrollChat();
}

// Navigate to a session route and load its messages.
async function navigateToSession(sessionId) {
  const app = Alpine.store("app");
  const llm = app.llm;
  const session = app.sessions.find(s => String(s.id) === String(sessionId));
  if (!session) return;
  // Already on this session — just navigate (no reload).
  if (String(llm.sessionId) === String(sessionId)) {
    window.PineconeRouter.navigate("/" + session.agentId + "/" + session.id);
    return;
  }
  await switchSession(sessionId);
  window.PineconeRouter.navigate("/" + session.agentId + "/" + session.id);
}

// Lazily create the DB session on the first message of a fresh chat.
async function ensureChatSession(llm) {
  if (llm.sessionId != null) return llm.sessionId;
  try {
    const s = await call("create_chat_session", {});
    llm.sessionId = s.id;
    // Refresh the session list so the new session appears in the sidebar.
    await loadSessions();
  } catch (err) {
    console.error("[ensureChatSession]", errText(err));
  }
  return llm.sessionId;
}

async function chat() {
  const llm = Alpine.store("app").llm;
  const prompt = llm.chatInput.trim();
  if (!prompt || llm.chatActive) return;
  const image = llm.pendingImage;
  const audio = llm.pendingAudio;
  llm.chatInput = "";
  llm.pendingImage = null;
  llm.pendingImageName = "";
  llm.pendingAudio = null;
  llm.pendingAudioName = "";
  llm.messages = [
    ...llm.messages,
    { role: "user", text: prompt, hasImage: !!image, hasAudio: !!audio },
    { role: "assistant", text: "", toolCalls: [] },
  ];
  llm.chatActive = true;
  scrollChat();

  const sessionId = await ensureChatSession(llm);
  if (sessionId != null) {
    call("append_chat_message", { sessionId, role: "user", content: prompt }).catch((err) =>
      console.error("[append user]", errText(err))
    );
  }

  const t0 = performance.now();
  let chunks = 0;
  let chars = 0;
  let full = "";
  const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

  chatCtrl = streamOperation("local_chat", { prompt, image: image || null, audio: audio || null }, {
    onEvent: (ev) => {
      if (ev.type === "token") {
        chunks += 1;
        chars += ev.text.length;
        full += ev.text;
        const msgs = llm.messages.slice();
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], text: full };
        llm.messages = msgs;
        llm.stats = `${chunks} chunks · ${chars} chars · ${elapsed()}`;
        scrollChat();
      } else if (ev.type === "toolCall") {
        const msgs = llm.messages.slice();
        const last = { ...msgs[msgs.length - 1] };
        last.toolCalls = [
          ...last.toolCalls,
          { id: ev.id, tool: ev.tool, args: ev.args, ok: null, summary: "" },
        ];
        msgs[msgs.length - 1] = last;
        llm.messages = msgs;
        scrollChat();
      } else if (ev.type === "toolResult") {
        const msgs = llm.messages.slice();
        const last = { ...msgs[msgs.length - 1] };
        last.toolCalls = last.toolCalls.map((tc) =>
          tc.id === ev.id ? { ...tc, ok: ev.ok, summary: ev.summary } : tc
        );
        msgs[msgs.length - 1] = last;
        llm.messages = msgs;
        scrollChat();
      }
    },
    onDone: () => {
      llm.stats = `done · ${chunks} chunks · ${chars} chars · ${elapsed()}`;
      llm.chatActive = false;
      chatCtrl = null;
      if (sessionId != null && full) {
        call("append_chat_message", { sessionId, role: "assistant", content: full }).catch((err) =>
          console.error("[append assistant]", errText(err))
        );
      }
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

let mediaRecorder = null;
let audioChunks = [];

async function toggleRecord() {
  const llm = Alpine.store("app").llm;
  if (llm.recording) {
    mediaRecorder?.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      const reader = new FileReader();
      reader.onload = () => {
        llm.pendingAudio = reader.result.split(",")[1];
        llm.pendingAudioName = `${(blob.size / 1024).toFixed(0)} KB`;
      };
      reader.readAsDataURL(blob);
      llm.recording = false;
    };
    mediaRecorder.start();
    llm.recording = true;
  } catch (err) {
    console.error("[toggleRecord]", errText(err));
  }
}

function clearAudio() {
  Alpine.store("app").llm.pendingAudio = null;
  Alpine.store("app").llm.pendingAudioName = "";
}

async function resetChat() {
  const llm = Alpine.store("app").llm;
  if (llm.chatActive) return;
  try {
    await call("local_llm_reset");
    // New chat = new DB session; the old one stays in history (sidebar).
    try {
      const s = await call("create_chat_session", {});
      llm.sessionId = s.id;
      await loadSessions();
    } catch (err) {
      llm.sessionId = null;
      console.error("[resetChat] session", errText(err));
    }
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

function copyLastMessage() {
  const llm = Alpine.store("app").llm;
  const last = llm.messages.filter(m => m.role === "assistant" && m.text).pop();
  if (last) navigator.clipboard?.writeText(last.text);
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
  switchSession,
  navigateToSession,
  promptChip,
  toggleSessions: () => window._toggleSessions?.(),
  toggleThinking,
  unloadModel,
  pickImage,
  onImageSelected,
  clearImage,
  toggleRecord,
  clearAudio,
  addNote,
  copyLastMessage,
});
