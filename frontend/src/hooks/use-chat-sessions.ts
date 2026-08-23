import { useCallback, useEffect, useRef } from "react";
import { call, errText, type ChatMessageInfo, type ChatSessionInfo } from "@/lib/api";
import { showErrorToast } from "@/lib/utils";
import { logError, logWarn } from "@/lib/logger";
import { historyToMessages, sessionPeriod } from "@/lib/chat-helpers";
import type { LocalChatState } from "./use-local-chat";
import type { StreamControl } from "@/lib/stream";

export function useChatSessions({
  agentId,
  patch,
  state,
  resetModelContext,
  streamCtrl,
  clearMessages,
}: {
  agentId: string;
  patch: (p: Partial<LocalChatState>) => void;
  state: LocalChatState;
  resetModelContext: () => Promise<void>;
  streamCtrl: React.MutableRefObject<StreamControl | null>;
  clearMessages: () => void;
}) {
  const sessionIdRef = useRef<number | null>(null);

  // keep ref in sync with state.sessionId for ensure* short-circuit
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

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
          agentId,
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
    [agentId, patch, loadSessions],
  );

  const newChat = useCallback(async () => {
    if (streamCtrl.current) return;
    await resetModelContext();
    sessionIdRef.current = null;
    patch({ sessionId: null });
    clearMessages();
  }, [patch, resetModelContext, streamCtrl, clearMessages]);

  const selectSession = useCallback(
    async (sessionId: number) => {
      if (streamCtrl.current) return;
      await resetModelContext();
      sessionIdRef.current = sessionId;
      patch({ sessionId });
      clearMessages();
      try {
        const rows = await call<ChatMessageInfo[]>("list_chat_messages", { sessionId });
        patch({ messages: historyToMessages(rows) });
      } catch (err) {
        logError("list_chat_messages", err);
      }
    },
    [patch, resetModelContext, streamCtrl, clearMessages],
  );

  const selectAgent = useCallback(async () => {
    if (streamCtrl.current) return;
    await resetModelContext();
    sessionIdRef.current = null;
    patch({ sessionId: null });
    clearMessages();
  }, [patch, resetModelContext, streamCtrl, clearMessages]);

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
        await resetModelContext();
        sessionIdRef.current = null;
        patch({ sessionId: null });
        clearMessages();
      }
      void loadSessions();
    },
    [patch, loadSessions, resetModelContext, streamCtrl, clearMessages],
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
        const updated = await call<ChatSessionInfo>("rename_chat_session", { sessionId, title: trimmed });
        patch({ sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)) });
      } catch (err) {
        logError("rename_chat_session", err);
        showErrorToast(`Couldn't rename the session — ${errText(err)}`);
        patch({ sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title: prior } : s)) });
      }
    },
    [state.sessions, patch],
  );

  const setSessionArchived = useCallback(
    async (sessionId: number, archived: boolean) => {
      try {
        await call<ChatSessionInfo>("set_chat_session_archived", { sessionId, archived });
      } catch (err) {
        logError("set_chat_session_archived", err);
        showErrorToast(`${archived ? "Couldn't archive" : "Couldn't restore"} the session — ${errText(err)}`);
        await loadSessions();
        return;
      }
      if (archived && sessionIdRef.current === sessionId) {
        await resetModelContext();
        sessionIdRef.current = null;
        patch({ sessionId: null });
        clearMessages();
      }
      void loadSessions();
    },
    [patch, loadSessions, resetModelContext, clearMessages],
  );

  const agentSessions = state.sessions.filter((s) => s.agentId === agentId);
  const groupedSessions = agentSessions.length
    ? (["Today", "Yesterday", "Earlier"] as const)
        .map((label) => ({
          label,
          sessions: agentSessions.filter((s) => sessionPeriod(s.createdAt) === label),
        }))
        .filter((g) => g.sessions.length > 0)
    : [];

  return {
    sessionIdRef,
    loadSessions,
    ensureSessionId,
    newChat,
    selectSession,
    selectAgent,
    deleteSession,
    renameSession,
    setSessionArchived,
    groupedSessions,
  };
}
