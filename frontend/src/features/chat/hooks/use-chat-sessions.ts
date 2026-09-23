import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { type ChatMessageInfo, type ChatSessionInfo, call, errText } from "@/lib/api";
import { groupSessions, historyToMessages, sessionToMarkdown } from "@/features/chat/lib/chat-helpers";
import { logError, logWarn } from "@/lib/logger";
import type { StreamControl } from "@/lib/stream";
import { showErrorToast, slugify } from "@/lib/utils";
import type { SupervisorChatState } from "./use-supervisor-chat";

/** Undo window for a delete: the row disappears now, the real
 *  `delete_chat_session` call fires only after this expires unopposed. */
const DELETE_UNDO_MS = 5000;

/** Backend list order (list_chat_sessions): activity desc, then id desc. */
const byActivityDesc = (a: ChatSessionInfo, b: ChatSessionInfo) =>
  (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) || b.id - a.id;

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
    if (!state.userId) return;
    void (async () => {
      // Stale-session sweep (30+ idle days auto-archive) runs once per
      // session load, before the first list read. Idempotent UPDATE,
      // best-effort — a failure never blocks the list.
      try {
        await call<number>("archive_stale_sessions", {});
      } catch (err) {
        logWarn("archive_stale_sessions", err);
      }
      await loadSessions();
    })();
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

  const pendingDeletes = useRef(new Map<number, number>());
  // Unmount abandons pending deletes (sign-out / teardown): the rows were
  // only optimistically removed, so nothing is lost — they reload as-is.
  useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  /** Optimistically remove the rows, then delete for real once the Undo
   *  window expires. One timer + one Undo toast covers the whole batch (ids
   *  already pending are skipped so a solo delete can't collide with one). */
  const deleteSessions = useCallback(
    async (sessionIds: number[]) => {
      if (streamCtrl.current) return;
      const ids = sessionIds.filter((id) => !pendingDeletes.current.has(id));
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const targets = [...state.sessions, ...state.archivedSessions].filter((s) => idSet.has(s.id));
      if (targets.length === 0) return;

      patch({
        sessions: state.sessions.filter((s) => !idSet.has(s.id)),
        archivedSessions: state.archivedSessions.filter((s) => !idSet.has(s.id)),
      });
      const activeId = sessionIdRef.current;
      const wasActive = activeId != null && idSet.has(activeId);
      if (wasActive) await resetSession(null);

      const fire = () => {
        for (const id of ids) pendingDeletes.current.delete(id);
        void Promise.all(ids.map((id) => call("delete_chat_session", { sessionId: id }))).catch((err) => {
          logError("delete_chat_session", err);
          showErrorToast(
            `Couldn't delete ${ids.length === 1 ? "the session" : `${ids.length} sessions`} — ${errText(err)}`,
          );
          void loadSessions(); // reconcile: rows may still exist
        });
      };
      const timer = window.setTimeout(fire, DELETE_UNDO_MS);
      for (const id of ids) pendingDeletes.current.set(id, timer);

      const label =
        targets.length === 1
          ? `Deleted "${targets[0].title || `Session #${targets[0].id}`}"`
          : `Deleted ${targets.length} sessions`;
      toast(label, {
        duration: DELETE_UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            // A different timer owns this id now — or the window elapsed and
            // the delete already committed.
            if (pendingDeletes.current.get(ids[0]) !== timer) return;
            window.clearTimeout(timer);
            for (const id of ids) pendingDeletes.current.delete(id);
            void loadSessions(); // server still owns the rows — restore truth
            if (wasActive && activeId != null) void selectSession(activeId);
          },
        },
      });
    },
    [state.sessions, state.archivedSessions, patch, streamCtrl, resetSession, loadSessions, selectSession],
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

  /** Archive/restore a batch — optimistic move for every id living in either
   *  list, per-id server calls, then reconcile with server truth (drop every
   *  touched id from both lists, reinsert each row where it belongs). */
  const setSessionsArchived = useCallback(
    async (sessionIds: number[], archived: boolean) => {
      const ids = [...new Set(sessionIds)].filter((id) => id > 0);
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const priorSessions = state.sessions;
      const priorArchived = state.archivedSessions;
      const byCreatedDesc = byActivityDesc;
      const now = Math.floor(Date.now() / 1000);

      const moving = archived
        ? priorSessions.filter((s) => idSet.has(s.id))
        : priorArchived.filter((s) => idSet.has(s.id));
      const optimisticSessions = archived
        ? priorSessions.filter((s) => !idSet.has(s.id))
        : [
            ...priorArchived.filter((s) => !idSet.has(s.id)),
            ...moving.map((s) => ({ ...s, archived: false, archivedAt: null })),
          ].sort(byCreatedDesc);
      const optimisticArchived = archived
        ? [
            ...priorArchived.filter((s) => !idSet.has(s.id)),
            ...moving.map((s) => ({ ...s, archived: true, archivedAt: now })),
          ].sort(byCreatedDesc)
        : priorArchived.filter((s) => !idSet.has(s.id));
      patch({ sessions: optimisticSessions, archivedSessions: optimisticArchived });

      let updated: ChatSessionInfo[];
      try {
        updated = await Promise.all(
          ids.map((sessionId) => call<ChatSessionInfo>("set_chat_session_archived", { sessionId, archived })),
        );
      } catch (err) {
        logError("set_chat_session_archived", err);
        showErrorToast(
          `${archived ? "Couldn't archive" : "Couldn't restore"} ${
            ids.length === 1 ? "the session" : `${ids.length} sessions`
          } — ${errText(err)}`,
        );
        patch({ sessions: priorSessions, archivedSessions: priorArchived });
        return;
      }

      // Reconcile: drop every touched id from both lists, then reinsert each
      // server row where it belongs (rows that failed server-side stay out —
      // the error toast above said so; reload resyncs on the next list read).
      const finalSessions = optimisticSessions.filter((s) => !idSet.has(s.id));
      const finalArchived = optimisticArchived.filter((s) => !idSet.has(s.id));
      for (const u of updated) (u.archived ? finalArchived : finalSessions).push(u);
      finalSessions.sort(byCreatedDesc);
      finalArchived.sort(byCreatedDesc);
      patch({ sessions: finalSessions, archivedSessions: finalArchived });

      const activeId = sessionIdRef.current;
      if (archived && activeId != null && idSet.has(activeId)) await resetSession(null);
    },
    [state.sessions, state.archivedSessions, patch, resetSession],
  );

  /** Server-side session search (title + message content) — active and
   *  archived lists split exactly like `list_chat_sessions`. */
  const searchSessions = useCallback(async (query: string) => {
    const q = query.trim();
    const [sessions, archivedSessions] = await Promise.all([
      call<ChatSessionInfo[]>("list_chat_sessions", { archived: false, ...(q ? { query: q } : {}) }),
      call<ChatSessionInfo[]>("list_chat_sessions", { archived: true, ...(q ? { query: q } : {}) }),
    ]);
    return { sessions, archivedSessions };
  }, []);

  /** Export a session transcript to a stored `.md` file (previewable record;
   *  the hook toasts on failure and resolves null). */
  const exportSession = useCallback(
    async (session: ChatSessionInfo): Promise<{ id: string; originalName: string; bytes: number } | null> => {
      try {
        const rows = await call<ChatMessageInfo[]>("list_chat_messages", { sessionId: session.id });
        const md = sessionToMarkdown(session.title, rows);
        const filename = `${slugify(session.title ?? "", `session-${session.id}`)}.md`;
        const file = await call<{ id: string; originalName: string; bytes: number }>("export_deliverable", {
          markdown: md,
          filename,
        });
        toast.success(`Saved ${file.originalName}`);
        return file;
      } catch (err) {
        logError("export_deliverable", err);
        showErrorToast(`Couldn't export the session — ${errText(err)}`);
        return null;
      }
    },
    [],
  );

  const retryHistoryLoad = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid == null || streamCtrl.current) return;
    patch({ historyError: null });
    await loadMessages(sid);
  }, [streamCtrl, loadMessages, patch]);

  const groupedSessions = groupSessions(state.sessions);

  return {
    sessionIdRef,
    loadSessions,
    ensureSessionId,
    newChat,
    selectSession,
    deleteSessions,
    renameSession,
    setSessionsArchived,
    searchSessions,
    exportSession,
    retryHistoryLoad,
    groupedSessions,
  };
}
