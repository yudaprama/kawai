import { useCallback, useEffect } from "react";
import { call, errText, type LocalModelInfo } from "@/lib/api";
import { logError, logWarn } from "@/lib/logger";
import { toFriendlyError } from "@/lib/chat-helpers";
import type { LocalChatState } from "./use-local-chat";

export function useChatModel({
  patch,
  state,
}: {
  patch: (p: Partial<LocalChatState>) => void;
  state: LocalChatState;
}) {
  const loadModel = useCallback(async () => {
    if (state.modelLoaded || state.modelLoading) return;
    patch({ modelLoading: true, modelError: false, modelStatus: "loading model…" } as Partial<LocalChatState>);
    // Note: model may be downloading from HuggingFace on first launch —
    // this takes 5-15 min depending on connection. The backend's ensure_model()
    // logs progress to stderr (visible in `app.log`).
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
  }, [patch, state.modelLoaded, state.modelLoading]);

  // Auto-load once userId exists — same semantics as before (called from owner)
  useEffect(() => {
    if (state.userId && !state.modelLoaded && !state.modelLoading) {
      void loadModel();
    }
  }, [state.userId, state.modelLoaded, state.modelLoading, loadModel]);

  const resetModelContext = useCallback(async () => {
    try {
      await call("local_llm_reset");
    } catch (err) {
      logWarn("local_llm_reset", err);
    }
  }, []);

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

  const unloadModel = useCallback(
    async (streamActive: boolean) => {
      if (streamActive) return;
      try {
        await call("local_llm_unload");
        patch({
          modelLoaded: false,
          modelStatus: "",
          thinking: false,
        } as Partial<LocalChatState>);
      } catch (err) {
        logError("local_llm_unload", err);
      }
    },
    [patch],
  );

  return { loadModel, resetModelContext, toggleThinking, unloadModel };
}
