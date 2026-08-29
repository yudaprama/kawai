import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, ToolUIPart, UIMessage, UIMessagePart } from "@/lib/ai-types";
import type { AgentInfo, ChatSessionInfo } from "@/lib/api";
import { stripToolMarkup, toFriendlyError } from "@/lib/chat-helpers";
import { type StreamControl, streamOperation } from "@/lib/stream";
import { useAuth } from "./use-auth";
import { useChatModel } from "./use-chat-model";
import { useChatSessions } from "./use-chat-sessions";
// Single source of truth — generated from `crates/foundation/events` via `cargo run -p kawai-bindings --bin export-bindings`
import type { AgentChatEvent } from "@/generated/events";

// Re-export for callers that still import from this hook (back-compat)
export type LocalChatEvent = AgentChatEvent;

export interface PendingConfirmation {
  tool: string;
  prompt: string;
  acceptText: string;
  declineText: string;
}

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
  historyError: string | null;
  /** A tool waiting for explicit user confirmation (data_import card). */
  confirmation: PendingConfirmation | null;
  sessions: ChatSessionInfo[];
  archivedSessions: ChatSessionInfo[];
  sessionId: number | null;
}

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
    historyError: null,
    confirmation: null,
    sessions: [],
    archivedSessions: [],
    sessionId: null,
  });

  const streamCtrl = useRef<StreamControl | null>(null);
  const patch = useCallback((partial: Partial<LocalChatState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const { userId: authUserId, authError } = useAuth();
  const effectiveUserId = userId ?? authUserId;
  useEffect(() => {
    if (effectiveUserId) patch({ userId: effectiveUserId });
    if (authError) patch({ authError });
  }, [effectiveUserId, authError, patch]);

  const clearMessages = useCallback(
    () => patch({ messages: [], historyError: null, confirmation: null } as Partial<LocalChatState>),
    [patch],
  );

  const { loadModel, resetModelContext, toggleThinking, unloadModel } = useChatModel({ patch, state });
  const {
    ensureSessionId,
    loadSessions,
    newChat,
    selectSession,
    selectAgent,
    deleteSession,
    renameSession,
    setSessionArchived,
    retryHistoryLoad,
    groupedSessions,
  } = useChatSessions({
    agentId,
    patch,
    state,
    resetModelContext,
    streamCtrl,
    clearMessages,
  });

  // Finalizes the in-flight assistant message (marks streaming parts done).
  // Populated by send() while a stream is active; invoked by stop() because
  // cancel_stream means the channel usually never emits a terminal event.
  const finalizeAssistant = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    finalizeAssistant.current?.();
    finalizeAssistant.current = null;
    patch({ status: "ready" });
  }, [patch]);

  const unloadModelWithGuard = useCallback(async () => {
    if (streamCtrl.current) return;
    await unloadModel();
    // unloadModel in useChatModel only clears model fields; we also clear messages per original semantics
    patch({ messages: [] } as Partial<LocalChatState>);
  }, [unloadModel, patch]);

  const send = useCallback(
    async (text: string, fileIds?: string[]) => {
      const prompt = text.trim();
      if ((!prompt && (!fileIds || fileIds.length === 0)) || streamCtrl.current) return;

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
        confirmation: null,
      }));

      const sessionId = await ensureSessionId(prompt);
      let full = "";
      let toolParts: ToolUIPart[] = [];
      let reasoning: { provider: string; text: string; done: boolean } | null = null;
      const reasoningPart = (): UIMessagePart[] =>
        reasoning?.text
          ? [
              {
                type: "reasoning",
                text: reasoning.text,
                state: reasoning.done ? ("done" as const) : ("streaming" as const),
                providerMetadata: { provider: reasoning.provider },
              },
            ]
          : [];

      /** Build the assistant message parts from the current streaming state. */
      const assistantParts = (text: string, state: "streaming" | "done"): UIMessagePart[] =>
        text ? [{ type: "text", text, state }, ...toolParts, ...reasoningPart()] : [...toolParts, ...reasoningPart()];

      const setAssistantParts = (parts: UIMessagePart[], status?: ChatStatus) => {
        setState((prev) => ({
          ...prev,
          ...(status ? { status } : {}),
          messages: prev.messages.map((m) => (m.id === assistantId ? { ...m, parts } : m)),
        }));
      };
      const syncStreamingDisplay = () => {
        setAssistantParts(assistantParts(stripToolMarkup(full), "streaming"), "streaming");
      };
      finalizeAssistant.current = () => {
        if (reasoning) reasoning.done = true;
        setAssistantParts(assistantParts(stripToolMarkup(full), "done"));
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
              full += ev.text;
              if (reasoning) reasoning.done = true;
              syncStreamingDisplay();
            } else if (ev.type === "thinking") {
              // On-device reasoning: delta — append within the same model call,
              // start fresh when a cloud subagent's buffer owned the part before.
              reasoning =
                reasoning && reasoning.provider === "on-device"
                  ? {
                      ...reasoning,
                      text: reasoning.text + ev.text,
                      done: false,
                    }
                  : { provider: "on-device", text: ev.text, done: false };
              syncStreamingDisplay();
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
            } else if (ev.type === "confirmationRequest") {
              patch({
                confirmation: {
                  tool: ev.tool,
                  prompt: ev.prompt,
                  acceptText: ev.acceptText,
                  declineText: ev.declineText,
                },
              });
            } else if (ev.type === "toolResult") {
              toolParts = toolParts.map((p) =>
                p.type === `tool-${ev.tool}` &&
                ((ev.id != null && p.toolCallId === ev.id) ||
                  (ev.id == null && p.state !== "output-available" && p.state !== "output-error"))
                  ? {
                      ...p,
                      state: ev.ok ? ("output-available" as const) : ("output-error" as const),
                      output:
                        ev.data != null
                          ? { ok: ev.ok, summary: ev.summary, data: ev.data }
                          : { ok: ev.ok, summary: ev.summary },
                      ...(ev.ok ? {} : { errorText: ev.summary }),
                    }
                  : p,
              );
              syncStreamingDisplay();
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            finalizeAssistant.current = null;
            if (reasoning) reasoning.done = true;
            setAssistantParts(assistantParts(stripToolMarkup(full), "done"), "ready");
            void loadSessions();
          },
          onError: (err) => {
            streamCtrl.current = null;
            finalizeAssistant.current = null;
            const msg = toFriendlyError(err.message);
            const lower = err.message.toLowerCase();
            const isBusyRace = lower.includes("already running") || lower.includes("generation is already");
            if (reasoning) reasoning.done = true;
            const status: ChatStatus = isBusyRace ? "ready" : "error";
            setState((prev) => ({
              ...prev,
              status,
              error: msg,
              messages: prev.messages.map((m) =>
                m.id === assistantId ? { ...m, parts: assistantParts(full, "done") } : m,
              ),
            }));
          },
        },
      );
    },
    [agentId, ensureSessionId, loadSessions, patch],
  );

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
    retryHistoryLoad,
    toggleThinking,
    unloadModel: unloadModelWithGuard,
    reloadModel: loadModel,
    ensureSessionId,
  };
}
