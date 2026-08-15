// Global frontend error capture → backend `frontend_log` → kawai log file.
// Import this module FIRST in main.js so hooks are installed early.
// Everything is fire-and-forget; failures here must never throw.

const invoke = window.__TAURI__?.core?.invoke;

function send(level, message) {
  try {
    invoke?.("frontend_log", { level, message: String(message).slice(0, 4000) });
  } catch {
    /* logging must never break the app */
  }
}

function describe(err) {
  if (!err) return "unknown";
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (typeof err === "object") {
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

window.addEventListener("error", (e) => {
  send("js-error", e.message ? `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${describe(e.error)}` : describe(e.error));
});

window.addEventListener("unhandledrejection", (e) => {
  send("js-rejection", describe(e.reason));
});

const origError = console.error.bind(console);
console.error = (...args) => {
  send("console.error", args.map(describe).join(" "));
  origError(...args);
};

const origWarn = console.warn.bind(console);
console.warn = (...args) => {
  send("console.warn", args.map(describe).join(" "));
  origWarn(...args);
};

export { send as logToBackend };
