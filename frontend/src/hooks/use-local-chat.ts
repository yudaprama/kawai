import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  call,
  errText,
  type ChatMessageInfo,
  type ChatSessionInfo,
  type LocalModelInfo,
  type UserInfo,
} from "@/lib/api";
import { streamOperation, type StreamControl } from "@/lib/stream";
import type {
  ChatStatus,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "@/lib/ai-types";

/** Events emitted by the backend's `local_chat` stream (serde camelCase). */
type LocalChatEvent =
  | { type: "started" }
  | { type: "token"; text: string }
  | { type: "toolCall"; id: string | null; tool: string; args: unknown }
  | { type: "toolResult"; id: string | null; tool: string; ok: boolean; summary: string }
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
  sessionId: number | null;
}

function historyToMessages(rows: ChatMessageInfo[]): UIMessage[] {
  return rows.map((row) => ({
    id: `db-${row.id}`,
    role: row.role,
    parts: [{ type: "text", text: row.content, state: "done" }],
  }));
}

function sessionPeriod(createdAt: number | null): "Today" | "Yesterday" | "Earlier" {
  if (!createdAt) return "Earlier";
  const date = new Date(createdAt * 1000);
  const today = new Date();
  const isSameDay = date.toDateString() === today.toDateString();
  if (isSameDay) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return "Earlier";
}

export function useLocalChat(agentId: string) {
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
    sessionId: null,
  });

  const streamCtrl = useRef<StreamControl | null>(null);
  const sessionIdRef = useRef<number | null>(null);

  const patch = useCallback((partial: Partial<LocalChatState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // ---- Auth bootstrap (mirrors the vanilla app's tryRestoreSession) ----
  // With the backend dev bypass (KAWAI_AUTH_DEV_USER_ID) any token verifies;
  // in production this falls through to null until Clerk is wired in.
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const u = await call<UserInfo>("whoami");
        if (!disposed) patch({ userId: u.userId });
        return;
      } catch {
        // no session yet
      }
      try {
        const u = await call<UserInfo>("set_session", { token: "dev-clerk-unavailable" });
        if (!disposed) patch({ userId: u.userId });
      } catch (err) {
        if (!disposed) patch({ authError: errText(err) });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [patch]);

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
      patch({ modelLoading: false, modelError: true, modelStatus: errText(err) });
    }
  }, [patch]);

  // Auto-load once a session exists (the model load op is auth-required).
  useEffect(() => {
    if (state.userId && !state.modelLoaded && !state.modelLoading) {
      void loadModel();
    }
  }, [state.userId, state.modelLoaded, state.modelLoading, loadModel]);

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await call<ChatSessionInfo[]>("list_chat_sessions");
      patch({ sessions });
    } catch (err) {
      console.error("[list_chat_sessions]", errText(err));
    }
  }, [patch]);

  useEffect(() => {
    if (state.userId) void loadSessions();
  }, [state.userId, loadSessions]);

  const ensureSession = useCallback(
    async (firstMessage: string): Promise<number | null> => {
      if (sessionIdRef.current != null) return sessionIdRef.current;
      try {
        const s = await call<ChatSessionInfo>("create_chat_session", {
          agentId,
          title: firstMessage.slice(0, 80),
        });
        sessionIdRef.current = s.id;
        patch({ sessionId: s.id });
        void loadSessions();
        return s.id;
      } catch (err) {
        console.error("[create_chat_session]", errText(err));
        return null;
      }
    },
    [agentId, patch, loadSessions],
  );

  const newChat = useCallback(async () => {
    if (streamCtrl.current) return;
    try {
      await call("local_llm_reset");
    } catch (err) {
      console.error("[local_llm_reset]", errText(err));
    }
    sessionIdRef.current = null;
    patch({ sessionId: null, messages: [], stats: "" });
  }, [patch]);

  const selectSession = useCallback(
    async (sessionId: number) => {
      if (streamCtrl.current) return;
      // Clear model context — the Conversation API holds a single context.
      try {
        await call("local_llm_reset");
      } catch (err) {
        console.error("[local_llm_reset]", errText(err));
      }
      sessionIdRef.current = sessionId;
      patch({ sessionId, messages: [], stats: "" });
      try {
        const rows = await call<ChatMessageInfo[]>("list_chat_messages", { sessionId });
        patch({ messages: historyToMessages(rows) });
      } catch (err) {
        console.error("[list_chat_messages]", errText(err));
      }
    },
    [patch],
  );

  /** Switch agent: clear model context and start fresh (no session selected). */
  const selectAgent = useCallback(async () => {
    if (streamCtrl.current) return;
    try {
      await call("local_llm_reset");
    } catch (err) {
      console.error("[local_llm_reset]", errText(err));
    }
    sessionIdRef.current = null;
    patch({ sessionId: null, messages: [], stats: "" });
  }, [patch]);

  const toggleThinking = useCallback(async () => {
    const next = !state.thinking;
    patch({ thinking: next });
    try {
      await call("local_llm_set_thinking", { enabled: next });
    } catch (err) {
      console.error("[local_llm_set_thinking]", errText(err));
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
      console.error("[local_llm_unload]", errText(err));
    }
  }, [patch]);

  const stop = useCallback(() => {
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    patch({ status: "ready" });
  }, [patch]);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || streamCtrl.current) return;

      const userMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: prompt, state: "done" }],
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

      const sessionId = await ensureSession(prompt);
      if (sessionId != null) {
        call("append_chat_message", { sessionId, role: "user", content: prompt }).catch(
          (err) => console.error("[append user]", errText(err)),
        );
      }

      const t0 = performance.now();
      let chunks = 0;
      let chars = 0;
      let full = "";
      let toolParts: ToolUIPart[] = [];

      const setAssistantParts = (parts: UIMessagePart[], status?: ChatStatus, stats?: string) => {
        setState((prev) => ({
          ...prev,
          ...(status ? { status } : {}),
          ...(stats != null ? { stats } : {}),
          messages: prev.messages.map((m) => (m.id === assistantId ? { ...m, parts } : m)),
        }));
      };

      streamCtrl.current = streamOperation<LocalChatEvent>(
        "local_chat",
        { prompt },
        {
          onEvent: (ev) => {
            if (ev.type === "token") {
              chunks += 1;
              chars += ev.text.length;
              full += ev.text;
              setAssistantParts(
                [
                  { type: "text", text: full, state: "streaming" as const },
                  ...toolParts,
                ],
                "streaming",
                `${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
              );
            } else if (ev.type === "toolCall") {
              const part: ToolUIPart = {
                type: `tool-${ev.tool}`,
                toolCallId: ev.id ?? nanoid(),
                state: "input-available",
                input: ev.args,
              };
              toolParts = [...toolParts, part];
              setAssistantParts(
                full
                  ? [{ type: "text", text: full, state: "streaming" as const }, ...toolParts]
                  : [...toolParts],
                "streaming",
              );
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
              setAssistantParts(
                full
                  ? [{ type: "text", text: full, state: "streaming" as const }, ...toolParts]
                  : [...toolParts],
                "streaming",
              );
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            setAssistantParts(
              full
                ? [{ type: "text", text: full, state: "done" as const }, ...toolParts]
                : [...toolParts],
              "ready",
              `done · ${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
            );
            if (sessionId != null && full) {
              call("append_chat_message", { sessionId, role: "assistant", content: full }).catch(
                (err) => console.error("[append assistant]", errText(err)),
              );
            }
            void loadSessions();
          },
          onError: (err) => {
            streamCtrl.current = null;
            setState((prev) => ({
              ...prev,
              status: "error",
              error: err.message,
              messages: prev.messages.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      parts: full
                        ? [{ type: "text", text: full, state: "done" as const }, ...toolParts]
                        : [...toolParts],
                    }
                  : m,
              ),
            }));
          },
        },
      );
    },
    [ensureSession, loadSessions],
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
    toggleThinking,
    unloadModel,
    reloadModel: loadModel,
  };
}
