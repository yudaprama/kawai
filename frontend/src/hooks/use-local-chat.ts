import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useAuth } from "./use-auth";
import {
  call,
  errText,
  type AgentInfo,
  type ChatMessageInfo,
  type ChatSessionInfo,
  type LocalModelInfo,
} from "@/lib/api";
import { streamOperation, type StreamControl } from "@/lib/stream";
import { showErrorToast } from "@/lib/utils";
import { logError, logWarn } from "@/lib/logger";
import type {
  ChatStatus,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "@/lib/ai-types";
import { historyToMessages, sessionPeriod, stripToolMarkup, toFriendlyError } from "@/lib/chat-helpers";

/** Events emitted by the backend's `local_chat` / `agent_chat` streams. */
type LocalChatEvent =
  | { type: "started"; sessionId?: number }
  | { type: "token"; text: string }
  | { type: "toolCall"; id?: string | null; tool: string; args: unknown }
  | { type: "subagentThinking"; provider: string; text: string }
  | { type: "toolResult"; id?: string | null; tool: string; ok: boolean; summary: string }
  | { type: "finished" }
  | { type: "error"; message: string };

export interface LocalChatState {
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
  stats: string;
  sessions: ChatSessionInfo[];
  archivedSessions: ChatSessionInfo[];
  sessionId: number | null;
}

/**
 * @param agent the active catalog entry (from the `list_agents` op). The
 * backend owns agent ids; every agent (with or without tools) chats through
 * `agent_chat` — one code path, backend-side persistence + title generation.
 * @param userId optional authenticated user id; if provided the auth bootstrap
 * is skipped and this value is used directly.
 */
export function useLocalChat(agent: Pick<AgentInfo, "id">, userId?: string | null) {
  const { id: agentId } = agent;
  const [state, setState] = useState<LocalChatState>({
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
    stats: "",
    sessions: [],
    archivedSessions: [],
    sessionId: null,
  });

  const streamCtrl = useRef<StreamControl | null>(null);
  const sessionIdRef = useRef<number | null>(null);

  const patch = useCallback((partial: Partial<LocalChatState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const { userId: authUserId, authError } = useAuth();
  const effectiveUserId = userId ?? authUserId;

  useEffect(() => {
    if (effectiveUserId) patch({ userId: effectiveUserId });
    if (authError) patch({ authError });
  }, [effectiveUserId, authError]);

  const loadModel = useCallback(async () => {
    setState((prev) =>
      prev.modelLoaded || prev.modelLoading
        ? prev
        : { ...prev, modelLoading: true, modelError: false, modelStatus: "loading model…" },
    );
    try {
      const info = await call<LocalModelInfo>("local_load_model", {});
      patch({
        modelLoading: false,
        modelLoaded: true,
        modelStatus: `${info.modelPath.split("/").pop()} · ${info.backend}`,
      });
    } catch (err) {
      patch({ modelLoading: false, modelError: true, modelStatus: toFriendlyError(errText(err)) });
    }
  }, [patch]);

  // Auto-load once a session exists (the model load op is auth-required).
  useEffect(() => {
    if (state.userId && !state.modelLoaded && !state.modelLoading) {
      void loadModel();
    }
  }, [state.userId, state.modelLoaded, state.modelLoading, loadModel]);

  const resetModelContext = useCallback(async () => {
    try {
      await call("local_llm_reset");
    } catch (err) {
      // Best-effort: agent.rs force-resets on the opener path before transcript
      // replay, so a stale context never leaks even if this fails.
      logWarn("local_llm_reset", err);
    }
  }, []);

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

  /** Ensure a session exists, creating one with titleHint if needed. */
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
    patch({ sessionId: null, messages: [], stats: "" });
  }, [patch, resetModelContext]);

  const selectSession = useCallback(
    async (sessionId: number) => {
      if (streamCtrl.current) return;
      await resetModelContext();
      sessionIdRef.current = sessionId;
      patch({ sessionId, messages: [], stats: "" });
      try {
        const rows = await call<ChatMessageInfo[]>("list_chat_messages", { sessionId });
        patch({ messages: historyToMessages(rows) });
      } catch (err) {
        logError("list_chat_messages", err);
      }
    },
    [patch, resetModelContext],
  );

  /** Switch agent: clear model context and start fresh (no session selected). */
  const selectAgent = useCallback(async () => {
    if (streamCtrl.current) return;
    await resetModelContext();
    sessionIdRef.current = null;
    patch({ sessionId: null, messages: [], stats: "" });
  }, [patch, resetModelContext]);

  /** Delete a session (and its messages). Deleting the active session starts
   * a fresh chat; the model context is cleared either way. */
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
        patch({ sessionId: null, messages: [], stats: "" });
      }
      void loadSessions();
    },
    [patch, loadSessions, resetModelContext],
  );

  /** Rename a session (sidebar inline rename). Empty titles are rejected
   *  server-side; locally we keep the old title on failure. */
  const renameSession = useCallback(
    async (sessionId: number, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      const prior = state.sessions.find((s) => s.id === sessionId)?.title ?? null;
      patch({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, title: trimmed } : s,
        ),
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
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, title: prior } : s,
          ),
        });
      }
    },
    [state.sessions, patch],
  );

  /** Archive or restore a session. Archiving the ACTIVE session starts a
   *  fresh chat (same behaviour as deleting it); restoring only refetches. */
  const setSessionArchived = useCallback(
    async (sessionId: number, archived: boolean) => {
      try {
        await call<ChatSessionInfo>("set_chat_session_archived", { sessionId, archived });
      } catch (err) {
        logError("set_chat_session_archived", err);
        showErrorToast(
          `${archived ? "Couldn't archive" : "Couldn't restore"} the session — ${errText(err)}`,
        );
        await loadSessions();
        return;
      }
      if (archived && sessionIdRef.current === sessionId) {
        await resetModelContext();
        sessionIdRef.current = null;
        patch({ sessionId: null, messages: [], stats: "" });
      }
      void loadSessions();
    },
    [patch, loadSessions, resetModelContext],
  );

  const toggleThinking = useCallback(async () => {
    const next = !state.thinking;
    patch({ thinking: next });
    try {
      await call("local_llm_set_thinking", { enabled: next });
    } catch (err) {
      logError("local_llm_set_thinking", err);
      patch({ thinking: !next });
    }
  }, [state.thinking, patch]);

  const unloadModel = useCallback(async () => {
    if (streamCtrl.current) return;
    try {
      await call("local_llm_unload");
      patch({
        modelLoaded: false,
        modelStatus: "",
        messages: [],
        stats: "",
        thinking: false,
      });
    } catch (err) {
      logError("local_llm_unload", err);
    }
  }, [patch]);

  const stop = useCallback(() => {
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    patch({ status: "ready" });
  }, [patch]);

  const send = useCallback(
    async (text: string, imageB64?: string, fileIds?: string[]) => {
      const prompt = text.trim();
      if ((!prompt && !imageB64) || streamCtrl.current) return;

      const userParts: UIMessagePart[] = [];
      if (prompt) userParts.push({ type: "text", text: prompt, state: "done" });
      if (imageB64) {
        userParts.push({
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${imageB64}`,
        });
      }
      const userMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: userParts,
      };
      const assistantId = nanoid();
      const assistantMessage: UIMessage = {
        id: assistantId,
        role: "assistant",
        parts: [],
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, assistantMessage],
        status: "submitted",
        error: null,
        stats: "",
      }));

      // All agents go through `agent_chat` — the backend owns persistence
      // (user + assistant turns) and fires title generation after its own
      // append, so the title generator never races the message insert.
      const sessionId = await ensureSessionId(prompt);

      const t0 = performance.now();
      let chunks = 0;
      let chars = 0;
      let full = "";
      let toolParts: ToolUIPart[] = [];
      // Cloud-subagent reasoning (`subagentThinking` events): `text` is the
      // FULL visible buffer from the backend (replace semantics). `done`
      // flips when the answer phase starts so the collapsible auto-closes.
      // Display-only — never persisted with the message.
      let reasoning: { provider: string; text: string; done: boolean } | null = null;
      const reasoningPart = (): UIMessagePart[] =>
        reasoning && reasoning.text
          ? [
              {
                type: "reasoning",
                text: reasoning.text,
                state: reasoning.done ? ("done" as const) : ("streaming" as const),
                providerMetadata: { provider: reasoning.provider },
              },
            ]
          : [];

      const setAssistantParts = (parts: UIMessagePart[], status?: ChatStatus, stats?: string) => {
        setState((prev) => ({
          ...prev,
          ...(status ? { status } : {}),
          ...(stats != null ? { stats } : {}),
          messages: prev.messages.map((m) => (m.id === assistantId ? { ...m, parts } : m)),
        }));
      };

      const syncStreamingDisplay = (stats?: string) => {
        const displayText = stripToolMarkup(full);
        setAssistantParts(
          displayText
            ? [
                { type: "text", text: displayText, state: "streaming" as const },
                ...toolParts,
                ...reasoningPart(),
              ]
            : [...toolParts, ...reasoningPart()],
          "streaming",
          stats,
        );
      };

      streamCtrl.current = streamOperation<LocalChatEvent>(
        "agent_chat",
        {
          agentId,
          sessionId,
          message: prompt,
          ...(fileIds && fileIds.length > 0 ? { fileIds } : {}),
        },
        {
          onEvent: (ev) => {
            if (ev.type === "token") {
              chunks += 1;
              chars += ev.text.length;
              full += ev.text;
              // Answer tokens started — the subagent's thinking is over.
              if (reasoning) reasoning.done = true;
              syncStreamingDisplay(
                `${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
              );
            } else if (ev.type === "subagentThinking") {
              reasoning = { provider: ev.provider, text: ev.text, done: false };
              syncStreamingDisplay();
            } else if (ev.type === "toolCall") {
              const part: ToolUIPart = {
                type: `tool-${ev.tool}`,
                toolCallId: ev.id ?? nanoid(),
                state: "input-available",
                input: ev.args,
              };
              toolParts = [...toolParts, part];
              syncStreamingDisplay();
            } else if (ev.type === "toolResult") {
              toolParts = toolParts.map((p) =>
                p.type === `tool-${ev.tool}` &&
                ((ev.id != null && p.toolCallId === ev.id) ||
                  (ev.id == null && p.state !== "output-available" && p.state !== "output-error"))
                  ? {
                      ...p,
                      state: ev.ok ? ("output-available" as const) : ("output-error" as const),
                      output: { ok: ev.ok, summary: ev.summary },
                      ...(ev.ok ? {} : { errorText: ev.summary }),
                    }
                  : p,
              );
              syncStreamingDisplay();
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            if (reasoning) reasoning.done = true;

            // Strip fence blocks from final display text
            const displayText = stripToolMarkup(full);

            setAssistantParts(
              displayText
                ? [
                    { type: "text", text: displayText, state: "done" as const },
                    ...toolParts,
                    ...reasoningPart(),
                  ]
                : [...toolParts, ...reasoningPart()],
              "ready",
              `done · ${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
            );
            void loadSessions();
          },
          onError: (err) => {
            streamCtrl.current = null;
            const msg = toFriendlyError(err.message);
            // Transient concurrency race — downgrade to ready, don't scare user.
            const lower = err.message.toLowerCase();
            const isBusyRace = lower.includes("already running") || lower.includes("generation is already");
            if (reasoning) reasoning.done = true;
            if (isBusyRace) {
              setState((prev) => ({
                ...prev,
                status: "ready",
                error: msg,
                messages: prev.messages.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        parts: full
                          ? [
                              { type: "text", text: full, state: "done" as const },
                              ...toolParts,
                              ...reasoningPart(),
                            ]
                          : [...toolParts, ...reasoningPart()],
                      }
                    : m,
                ),
              }));
              return;
            }
            setState((prev) => ({
              ...prev,
              status: "error",
              error: msg,
              messages: prev.messages.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      parts: full
                        ? [
                            { type: "text", text: full, state: "done" as const },
                            ...toolParts,
                            ...reasoningPart(),
                          ]
                        : [...toolParts, ...reasoningPart()],
                    }
                  : m,
              ),
            }));
          },
        },
      );
    },
    [agentId, ensureSessionId, loadSessions],
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
    ...state,
    groupedSessions,
    send,
    stop,
    newChat,
    selectSession,
    selectAgent,
    deleteSession,
    renameSession,
    setSessionArchived,
    toggleThinking,
    unloadModel,
    reloadModel: loadModel,
    ensureSessionId,
  };
}
