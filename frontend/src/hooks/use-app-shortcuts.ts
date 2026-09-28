import { useEffect } from "react";

export function useAppShortcuts({
  busy,
  onOpenSessions,
  onNewChat,
}: {
  busy: boolean;
  onOpenSessions: () => void;
  onNewChat: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Same gate as the "?" cheat-sheet handler: while a modal dialog owns
      // the keyboard, a global shortcut must not stack another dialog over
      // it (double backdrop, ambiguous Esc) — the browser default stays
      // suppressed either way.
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        if (document.querySelector("[role=dialog]") != null) return;
        onOpenSessions();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (document.querySelector("[role=dialog]") != null) return;
        if (!busy) void onNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onOpenSessions, onNewChat]);
}
