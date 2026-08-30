import { useCallback, useEffect, useRef } from "react";
import { call, errText, type LocalModelInfo, type LocalModelStatus } from "@/lib/api";
import { toFriendlyError } from "@/lib/chat-helpers";
import { logError, logWarn } from "@/lib/logger";
import type { SupervisorChatState } from "./use-supervisor-chat";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1e6;
  return `${mb.toFixed(0)} MB`;
}

function statusMessage(st: LocalModelStatus): string {
  switch (st.status) {
    case "downloading": {
      const pct = st.totalBytes > 0 ? Math.round((st.downloadedBytes / st.totalBytes) * 100) : 0;
      return `Mengunduh model… ${pct}% (${formatBytes(st.downloadedBytes)} / ${formatBytes(st.totalBytes)}). Menggunakan cloud model sementara.`;
    }
    case "loading":
      return "Memuat model… Menggunakan cloud model sementara.";
    case "ready":
      return "Model siap.";
    case "failed":
      return "Gagal memuat model lokal. Menggunakan cloud model.";
    default:
      return "loading model…";
  }
}

export function useChatModel({ patch, state }: { patch: (p: Partial<SupervisorChatState>) => void; state: SupervisorChatState }) {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadModel = useCallback(async () => {
    if (state.modelLoaded || state.modelLoading) return;
    patch({
      modelLoading: true,
      modelError: false,
      modelStatus: "loading model…",
    } as Partial<SupervisorChatState>);

    // Check current status before loading — may already be downloading.
    try {
      const initial = await call<LocalModelStatus>("local_model_status");
      patch({ modelStatus: statusMessage(initial) });
    } catch {
      // Non-fatal — proceed with load.
    }

    // Start polling status every 2s while loading.
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await call<LocalModelStatus>("local_model_status");
        patch({ modelStatus: statusMessage(st) });
      } catch {
        // Polling failure is non-fatal — the load call will resolve.
      }
    }, 2000);

    // Note: model may be downloading from HuggingFace on first launch —
    // this takes 5-15 min depending on connection. The backend's ensure_model()
    // logs progress to stderr (visible in `app.log`).
    try {
      const info = await call<LocalModelInfo>("local_load_model", {});
      stopPolling();
      patch({
        modelLoading: false,
        modelLoaded: true,
        modelStatus: `${info.modelPath.split("/").pop()} · ${info.backend}`,
      });
    } catch (err) {
      stopPolling();
      patch({
        modelLoading: false,
        modelError: true,
        modelStatus: toFriendlyError(errText(err)),
      });
    }
  }, [patch, state.modelLoaded, state.modelLoading, stopPolling]);

  // Auto-load once userId exists — same semantics as before (called from owner)
  useEffect(() => {
    if (state.userId && !state.modelLoaded && !state.modelLoading) {
      void loadModel();
    }
  }, [state.userId, state.modelLoaded, state.modelLoading, loadModel]);

  // Cleanup polling on unmount.
  useEffect(() => () => stopPolling(), [stopPolling]);

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

  const unloadModel = useCallback(async () => {
    try {
      await call("local_llm_unload");
      patch({
        modelLoaded: false,
        modelStatus: "",
        thinking: false,
      } as Partial<SupervisorChatState>);
    } catch (err) {
      logError("local_llm_unload", err);
    }
  }, [patch]);

  return { loadModel, resetModelContext, toggleThinking, unloadModel };
}
