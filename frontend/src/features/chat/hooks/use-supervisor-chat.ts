import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, UIMessage } from "@/lib/ai-types";
import type { ChatSessionInfo } from "@/lib/api";
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
  sessions: ChatSessionInfo[];
  archivedSessions: ChatSessionInfo[];
  sessionId: number | null;
}

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
    sessionId: null,
  });

  const streamCtrl = useRef<{ cancel: () => void } | null>(null);
  const patch = useCallback((partial: Partial<SupervisorChatState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const { userId: authUserId, authError, logout } = useAuth();
  const effectiveUserId = userId ?? authUserId;
  useEffect(() => {
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
    deleteSession,
    renameSession,
    setSessionArchived,
    retryHistoryLoad,
    groupedSessions,
    loadSessions,
  } = useChatSessions({
    patch,
    state,
    resetModelContext,
    streamCtrl,
    clearMessages,
  });

  const stop = useCallback(() => {
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    patch({ status: "ready" });
  }, [patch]);

  const unloadModelWithGuard = useCallback(async () => {
    if (streamCtrl.current) return;
    await unloadModel();
    // unloadModel in useChatModel only clears model fields; we also clear messages per original semantics
    patch({ messages: [] } as Partial<SupervisorChatState>);
  }, [unloadModel, patch]);

  return {
    ...state,
    groupedSessions,
    stop,
    newChat,
    selectSession,
    deleteSession,
    renameSession,
    setSessionArchived,
    retryHistoryLoad,
    toggleThinking,
    unloadModel: unloadModelWithGuard,
    reloadModel: loadModel,
    ensureSessionId,
    refreshSessions: loadSessions,
    logout,
  };
}
