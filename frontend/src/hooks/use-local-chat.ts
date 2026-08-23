import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { useAuth } from "./use-auth";
import { type AgentInfo, type ChatSessionInfo } from "@/lib/api";
import { streamOperation, type StreamControl } from "@/lib/stream";
import type { ChatStatus, ToolUIPart, UIMessage, UIMessagePart } from "@/lib/ai-types";
import { stripToolMarkup, toFriendlyError } from "@/lib/chat-helpers";
import { useChatModel } from "./use-chat-model";
import { useChatSessions } from "./use-chat-sessions";

/** Events emitted by the backend's `local_chat` / `agent_chat` streams. */
export type LocalChatEvent =
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
  const patch = useCallback((partial: Partial<LocalChatState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const { userId: authUserId, authError } = useAuth();
  const effectiveUserId = userId ?? authUserId;
  useEffect(() => {
    if (effectiveUserId) patch({ userId: effectiveUserId });
    if (authError) patch({ authError });
  }, [effectiveUserId, authError]);

  const clearMessages = useCallback(() => patch({ messages: [], stats: "" } as Partial<LocalChatState>), [patch]);

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
    groupedSessions,
  } = useChatSessions({ agentId, patch, state, resetModelContext, streamCtrl, clearMessages });

  const stop = useCallback(() => {
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    patch({ status: "ready" });
  }, [patch]);

  const unloadModelWithGuard = useCallback(async () => {
    if (streamCtrl.current) return;
    await unloadModel(streamCtrl.current != null);
    // unloadModel in useChatModel only clears model fields; we also clear messages per original semantics
    patch({ messages: [], stats: "" } as Partial<LocalChatState>);
  }, [unloadModel, patch]);

  const send = useCallback(
    async (text: string, imageB64?: string, fileIds?: string[]) => {
      const prompt = text.trim();
      if ((!prompt && !imageB64) || streamCtrl.current) return;

      const userParts: UIMessagePart[] = [];
      if (prompt) userParts.push({ type: "text", text: prompt, state: "done" });
      if (imageB64) {
        userParts.push({ type: "file", mediaType: "image/png", url: `data:image/png;base64,${imageB64}` });
      }
      const userMessage: UIMessage = { id: nanoid(), role: "user", parts: userParts };
      const assistantId = nanoid();
      const assistantMessage: UIMessage = { id: assistantId, role: "assistant", parts: [] };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, assistantMessage],
        status: "submitted",
        error: null,
        stats: "",
      }));

      const sessionId = await ensureSessionId(prompt);
      const t0 = performance.now();
      let chunks = 0;
      let chars = 0;
      let full = "";
      let toolParts: ToolUIPart[] = [];
      let reasoning: { provider: string; text: string; done: boolean } | null = null;
      const reasoningPart = (): UIMessagePart[] =>
        reasoning && reasoning.text
          ? [{ type: "reasoning", text: reasoning.text, state: reasoning.done ? ("done" as const) : ("streaming" as const), providerMetadata: { provider: reasoning.provider } }]
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
          displayText ? [{ type: "text", text: displayText, state: "streaming" as const }, ...toolParts, ...reasoningPart()] : [...toolParts, ...reasoningPart()],
          "streaming",
          stats,
        );
      };

      streamCtrl.current = streamOperation<LocalChatEvent>(
        "agent_chat",
        { agentId, sessionId, message: prompt, ...(fileIds && fileIds.length > 0 ? { fileIds } : {}) },
        {
          onEvent: (ev) => {
            if (ev.type === "token") {
              chunks += 1;
              chars += ev.text.length;
              full += ev.text;
              if (reasoning) reasoning.done = true;
              syncStreamingDisplay(`${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
            } else if (ev.type === "subagentThinking") {
              reasoning = { provider: ev.provider, text: ev.text, done: false };
              syncStreamingDisplay();
            } else if (ev.type === "toolCall") {
              const part: ToolUIPart = { type: `tool-${ev.tool}`, toolCallId: ev.id ?? nanoid(), state: "input-available", input: ev.args };
              toolParts = [...toolParts, part];
              syncStreamingDisplay();
            } else if (ev.type === "toolResult") {
              toolParts = toolParts.map((p) =>
                p.type === `tool-${ev.tool}` &&
                ((ev.id != null && p.toolCallId === ev.id) || (ev.id == null && p.state !== "output-available" && p.state !== "output-error"))
                  ? { ...p, state: ev.ok ? ("output-available" as const) : ("output-error" as const), output: { ok: ev.ok, summary: ev.summary }, ...(ev.ok ? {} : { errorText: ev.summary }) }
                  : p,
              );
              syncStreamingDisplay();
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            if (reasoning) reasoning.done = true;
            const displayText = stripToolMarkup(full);
            setAssistantParts(
              displayText ? [{ type: "text", text: displayText, state: "done" as const }, ...toolParts, ...reasoningPart()] : [...toolParts, ...reasoningPart()],
              "ready",
              `done · ${chunks} chunks · ${chars} chars · ${((performance.now() - t0) / 1000).toFixed(1)}s`,
            );
            void loadSessions();
          },
          onError: (err) => {
            streamCtrl.current = null;
            const msg = toFriendlyError(err.message);
            const lower = err.message.toLowerCase();
            const isBusyRace = lower.includes("already running") || lower.includes("generation is already");
            if (reasoning) reasoning.done = true;
            if (isBusyRace) {
              setState((prev) => ({
                ...prev,
                status: "ready",
                error: msg,
                messages: prev.messages.map((m) =>
                  m.id === assistantId ? { ...m, parts: full ? [{ type: "text", text: full, state: "done" as const }, ...toolParts, ...reasoningPart()] : [...toolParts, ...reasoningPart()] } : m,
                ),
              }));
              return;
            }
            setState((prev) => ({
              ...prev,
              status: "error",
              error: msg,
              messages: prev.messages.map((m) =>
                m.id === assistantId ? { ...m, parts: full ? [{ type: "text", text: full, state: "done" as const }, ...toolParts, ...reasoningPart()] : [...toolParts, ...reasoningPart()] } : m,
              ),
            }));
          },
        },
      );
    },
    [agentId, ensureSessionId, loadSessions],
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
    toggleThinking,
    unloadModel: unloadModelWithGuard,
    reloadModel: loadModel,
    ensureSessionId,
  };
}
