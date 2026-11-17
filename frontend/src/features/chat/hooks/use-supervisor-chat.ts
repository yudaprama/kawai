import { useCallback, useEffect, useState } from "react";
import type { ChatStatus, UIMessage } from "@/lib/ai-types";
import type { ChatSession } from "@/lib/api";
import { useAuth } from "@/features/auth/use-auth";
import { useChatModel } from "./use-chat-model";
import { useChatSessions } from "./use-chat-sessions";
export interface SupervisorConfirmation {
  streamId: string;
  stepId: string;
  tool: string;
  prompt: string;
  acceptText: string;
  declineText: string;
}

export interface SupervisorChatState {
  userId: string | null;
  authError: string | null;
  modelLoading: boolean;
  modelLoaded: boolean;
  modelStatus: string;
  modelError: boolean;
  thinking: boolean;
  messages: UIMessage[];
  status: ChatStatus;
  error: string | null;
  historyError: string | null;
  /** A tool waiting for explicit user confirmation (data_import card). */
  confirmation: SupervisorConfirmation | null;
  sessions: ChatSession[];
  archivedSessions: ChatSession[];
  /** Session list lifecycle — the switcher shows a skeleton during the first
   *  fetch and a retry row on failure, never a false "No sessions yet". */
  sessionsLoading: boolean;
  sessionsError: string | null;
  sessionId: number | null;
}

/**
 * Merge a partial state update — or a FUNCTION of the previous state. The
 * function form exists so an async continuation (a rename round-trip, a list
 * reload) never maps over the `state` snapshot it captured before the await.
 */
export type StatePatch = (
  partial: Partial<SupervisorChatState> | ((prev: SupervisorChatState) => Partial<SupervisorChatState>),
) => void;

export function useSupervisorChat(userId?: string | null) {
  const [state, setState] = useState<SupervisorChatState>({
    userId: null,
    authError: null,
    modelLoading: false,
    modelLoaded: false,
    modelStatus: "",
    modelError: false,
    thinking: false,
    messages: [],
    status: "ready",
    error: null,
    historyError: null,
    confirmation: null,
    sessions: [],
    archivedSessions: [],
    sessionsLoading: true,
    sessionsError: null,
    sessionId: null,
  });

  /**
   * Merge a partial state update. Accepts a FUNCTION of the previous state so
   * an async continuation (a rename round-trip, a list reload) never maps over
   * the `state` it captured at call time — that stale snapshot silently drops
   * whatever landed meanwhile.
   */
  const patch: StatePatch = useCallback((partial) => {
    setState((prev) => ({ ...prev, ...(typeof partial === "function" ? partial(prev) : partial) }));
  }, []);

  const { userId: authUserId, authError, logout } = useAuth();
  const effectiveUserId = userId ?? authUserId;
  useEffect(() => {
    // The offline balance snapshot is per-account and is scoped by
    // `AuthProvider` BEFORE this subtree mounts (see `use-auth.tsx`) — this
    // effect only mirrors the identity into local state.
    if (effectiveUserId) patch({ userId: effectiveUserId });
    if (authError) patch({ authError });
  }, [effectiveUserId, authError, patch]);

  const clearMessages = useCallback(
    () => patch({ messages: [], historyError: null, confirmation: null } as Partial<SupervisorChatState>),
    [patch],
  );

  const { loadModel, resetModelContext, toggleThinking, unloadModel } = useChatModel({ patch, state });
  const {
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
    loadSessions,
  } = useChatSessions({
    patch,
    state,
    resetModelContext,
    clearMessages,
  });

  const unloadModelWithGuard = useCallback(async () => {
    await unloadModel();
    // unloadModel in useChatModel only clears model fields; we also clear messages per original semantics
    patch({ messages: [] } as Partial<SupervisorChatState>);
  }, [unloadModel, patch]);

  // Sign out: the auth store is shared with AuthGate, so clearing it unmounts
  // the whole signed-in tree (and with it every cached chat field) — no
  // per-field reset here.
  const signOut = useCallback(async () => {
    await logout();
  }, [logout]);

  return {
    ...state,
    groupedSessions,
    newChat,
    selectSession,
    deleteSessions,
    renameSession,
    setSessionsArchived,
    searchSessions,
    exportSession,
    retryHistoryLoad,
    toggleThinking,
    unloadModel: unloadModelWithGuard,
    reloadModel: loadModel,
    ensureSessionId,
    refreshSessions: loadSessions,
    logout: signOut,
  };
}
