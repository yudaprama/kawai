import { useCallback, useEffect, useRef } from "react";
import { type ChatMessageInfo, type ChatSessionInfo, call, errText } from "@/lib/api";
import { historyToMessages, sessionPeriod } from "@/features/chat/lib/chat-helpers";
import { logError, logWarn } from "@/lib/logger";
import type { StreamControl } from "@/lib/stream";
import { showErrorToast } from "@/lib/utils";
import type { SupervisorChatState } from "./use-supervisor-chat";

export function useChatSessions({
  patch,
  state,
  resetModelContext,
  streamCtrl,
  clearMessages,
}: {
  patch: (p: Partial<SupervisorChatState>) => void;
  state: SupervisorChatState;
  resetModelContext: () => Promise<void>;
  streamCtrl: React.MutableRefObject<StreamControl | null>;
  clearMessages: () => void;
}) {
  const sessionIdRef = useRef<number | null>(null);

  // keep ref in sync with state.sessionId for ensure* short-circuit
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  /** Reset to a fresh (no-session) state. Optionally sets the session to an existing id. */
  const resetSession = useCallback(
    async (sessionId: number | null) => {
      await resetModelContext();
      sessionIdRef.current = sessionId;
      patch({ sessionId, historyError: null });
      clearMessages();
    },
    [patch, resetModelContext, clearMessages],
  );

  const loadSessions = useCallback(async () => {
    try {
      const [sessions, archivedSessions] = await Promise.all([
        call<ChatSessionInfo[]>("list_chat_sessions", { archived: false }),
        call<ChatSessionInfo[]>("list_chat_sessions", { archived: true }),
      ]);
      patch({ sessions, archivedSessions });
    } catch (err) {
      logWarn("list_chat_sessions", err);
    }
  }, [patch]);

  useEffect(() => {
    if (state.userId) void loadSessions();
  }, [state.userId, loadSessions]);

  const ensureSessionId = useCallback(
    async (titleHint = "New chat"): Promise<number | null> => {
      if (sessionIdRef.current != null) return sessionIdRef.current;
      try {
        const s = await call<ChatSessionInfo>("create_chat_session", {
          title: titleHint.slice(0, 80) || "New chat",
        });
        sessionIdRef.current = s.id;
        patch({ sessionId: s.id });
        void loadSessions();
        return s.id;
      } catch (err) {
        logError("create_chat_session", err);
        showErrorToast(`Couldn't start a new chat — ${errText(err)}`);
        return null;
      }
    },
    [patch, loadSessions],
  );

  const newChat = useCallback(async () => {
    if (streamCtrl.current) return;
    await resetSession(null);
  }, [streamCtrl, resetSession]);

  const loadMessages = useCallback(
    async (sessionId: number) => {
      try {
        const rows = await call<ChatMessageInfo[]>("list_chat_messages", {
          sessionId,
        });
        patch({ messages: historyToMessages(rows), historyError: null });
      } catch (err) {
        logError("list_chat_messages", err);
        patch({ historyError: errText(err) });
      }
    },
    [patch],
  );

  const selectSession = useCallback(
    async (sessionId: number) => {
      if (streamCtrl.current) return;
      await resetSession(sessionId);
      await loadMessages(sessionId);
    },
    [streamCtrl, resetSession, loadMessages],
  );

  const deleteSession = useCallback(
    async (sessionId: number) => {
      if (streamCtrl.current) return;
      try {
        await call("delete_chat_session", { sessionId });
      } catch (err) {
        logError("delete_chat_session", err);
        showErrorToast(`Couldn't delete the session — ${errText(err)}`);
        return;
      }
      if (sessionIdRef.current === sessionId) {
        await resetSession(null);
      }
      void loadSessions();
    },
    [loadSessions, streamCtrl, resetSession],
  );

  const renameSession = useCallback(
    async (sessionId: number, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const prior = state.sessions.find((s) => s.id === sessionId)?.title ?? null;
      patch({
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s)),
      });
      try {
        const updated = await call<ChatSessionInfo>("rename_chat_session", {
          sessionId,
          title: trimmed,
        });
        patch({
          sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)),
        });
      } catch (err) {
        logError("rename_chat_session", err);
        showErrorToast(`Couldn't rename the session — ${errText(err)}`);
        patch({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: prior } : s)),
        });
      }
    },
    [state.sessions, patch],
  );

  const setSessionArchived = useCallback(
    async (sessionId: number, archived: boolean) => {
      const priorSessions = state.sessions;
      const priorArchived = state.archivedSessions;
      const byCreatedDesc = (a: ChatSessionInfo, b: ChatSessionInfo) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

      let optimisticSessions: ChatSessionInfo[];
      let optimisticArchived: ChatSessionInfo[];
      if (archived) {
        const moving = priorSessions.find((s) => s.id === sessionId);
        optimisticSessions = priorSessions.filter((s) => s.id !== sessionId);
        optimisticArchived = moving
          ? [...priorArchived, { ...moving, archived: true, archivedAt: Math.floor(Date.now() / 1000) }].sort(
              byCreatedDesc,
            )
          : [...priorArchived].sort(byCreatedDesc);
      } else {
        const moving = priorArchived.find((s) => s.id === sessionId);
        optimisticArchived = priorArchived.filter((s) => s.id !== sessionId);
        optimisticSessions = moving
          ? [...priorSessions, { ...moving, archived: false, archivedAt: null }].sort(byCreatedDesc)
          : [...priorSessions].sort(byCreatedDesc);
      }
      patch({ sessions: optimisticSessions, archivedSessions: optimisticArchived });

      let updated: ChatSessionInfo;
      try {
        updated = await call<ChatSessionInfo>("set_chat_session_archived", {
          sessionId,
          archived,
        });
      } catch (err) {
        logError("set_chat_session_archived", err);
        showErrorToast(`${archived ? "Couldn't archive" : "Couldn't restore"} the session — ${errText(err)}`);
        patch({ sessions: priorSessions, archivedSessions: priorArchived });
        return;
      }

      // Reconcile with server truth — the optimistically moved row may have
      // stale fields; replace it wherever it landed and ensure it lives in the
      // correct list.
      let finalSessions = optimisticSessions.map((s) => (s.id === sessionId ? updated : s));
      let finalArchived = optimisticArchived.map((s) => (s.id === sessionId ? updated : s));
      const inSessions = finalSessions.some((s) => s.id === sessionId);
      const inArchived = finalArchived.some((s) => s.id === sessionId);
      if (archived && inSessions && !inArchived) {
        finalSessions = finalSessions.filter((s) => s.id !== sessionId);
        finalArchived = [...finalArchived.filter((s) => s.id !== sessionId), updated].sort(byCreatedDesc);
      } else if (!archived && inArchived && !inSessions) {
        finalArchived = finalArchived.filter((s) => s.id !== sessionId);
        finalSessions = [...finalSessions.filter((s) => s.id !== sessionId), updated].sort(byCreatedDesc);
      } else if (archived && !inSessions && !inArchived) {
        finalArchived = [...finalArchived, updated].sort(byCreatedDesc);
      } else if (!archived && !inSessions && !inArchived) {
        finalSessions = [...finalSessions, updated].sort(byCreatedDesc);
      }
      patch({ sessions: finalSessions, archivedSessions: finalArchived });

      if (archived && sessionIdRef.current === sessionId) {
        await resetSession(null);
      }
    },
    [state.sessions, state.archivedSessions, patch, resetSession],
  );

  const retryHistoryLoad = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid == null || streamCtrl.current) return;
    patch({ historyError: null });
    await loadMessages(sid);
  }, [streamCtrl, loadMessages, patch]);

  const groupedSessions = state.sessions.length
    ? (["Today", "Yesterday", "Earlier"] as const)
        .map((label) => ({
          label,
          sessions: state.sessions.filter((s) => sessionPeriod(s.createdAt) === label),
        }))
        .filter((g) => g.sessions.length > 0)
    : [];

  return {
    sessionIdRef,
    loadSessions,
    ensureSessionId,
    newChat,
    selectSession,
    deleteSession,
    renameSession,
    setSessionArchived,
    retryHistoryLoad,
    groupedSessions,
  };
}
