import { useEffect } from "react";

export function useAppShortcuts({
  busy,
  onToggleAgentsRail,
  onToggleCanvas,
  onToggleSessions,
  onNewChat,
}: {
  busy: boolean;
  onToggleAgentsRail: () => void;
  onToggleCanvas: () => void;
  onToggleSessions: () => void;
  onNewChat: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        onToggleAgentsRail();
      } else if (e.key === "2") {
        e.preventDefault();
        onToggleCanvas();
      } else if (e.key === "3") {
        e.preventDefault();
        onToggleSessions();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (!busy) void onNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onToggleAgentsRail, onToggleCanvas, onToggleSessions, onNewChat]);
}
