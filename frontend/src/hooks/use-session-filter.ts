import { useMemo } from "react";
import type { ChatSessionInfo } from "@/lib/api";

interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

export function useSessionFilter(
  groupedSessions: SessionGroup[],
  archivedSessions: ChatSessionInfo[],
  query: string,
) {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { filteredGroups: groupedSessions, filteredArchived: archivedSessions, q };
    const filteredGroups = groupedSessions
      .map((g) => ({ ...g, sessions: g.sessions.filter((s) => (s.title ?? "").toLowerCase().includes(q)) }))
      .filter((g) => g.sessions.length > 0);
    const filteredArchived = archivedSessions.filter((s) => (s.title ?? "").toLowerCase().includes(q));
    return { filteredGroups, filteredArchived, q };
  }, [groupedSessions, archivedSessions, query]);
}
