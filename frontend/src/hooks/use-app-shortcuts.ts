import { useEffect } from "react";

export function useAppShortcuts({
  busy,
  onToggleCanvas,
  onOpenSessions,
  onNewChat,
}: {
  busy: boolean;
  onToggleCanvas?: () => void;
  onOpenSessions: () => void;
  onNewChat: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "2") {
        e.preventDefault();
        onToggleCanvas?.();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        onOpenSessions();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (!busy) void onNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onToggleCanvas, onOpenSessions, onNewChat]);
}
