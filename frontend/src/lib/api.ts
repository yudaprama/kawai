import { invoke } from "@tauri-apps/api/core";

/**
 * Request-response RPC to the Tauri backend (in-process IPC). Command names
 * are the snake_case Rust fn names; args are camelCase on the JS side.
 */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args ?? {});
}

/** Tauri invoke rejects with a bare string, not an Error. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Open a stored file in the OS default viewer (desktop only). */
export function tauriOpenFile(fileId: string): Promise<void> {
  return call<void>("tauri_open_file", { fileId });
}

export function respondSupervisorConfirmation(streamId: string, stepId: string, approved: boolean): Promise<void> {
  return call<void>("respond_supervisor_confirmation", { streamId, stepId, approved });
}

import type {
  AgentInfo,
  ChatSessionInfo,
  CodegraphExploreResult,
  CodegraphStatusResult,
  KnowledgeFileInfo,
  LocalModelInfo,
  LocalModelStatus,
  MemoryGraphExport,
  MemoryItem,
  OfficeFileInfo,
  RagHit,
  SceneHit,
  SkillInfo,
  SqlProfile,
  SqlProfileTest,
  UserInfo,
} from "@/generated/api-types";

export type {
  AgentInfo,
  ChatSessionInfo,
  CodegraphExploreResult,
  CodegraphStatusResult,
  KnowledgeFileInfo,
  LocalModelInfo,
  LocalModelStatus,
  MemoryGraphExport,
  MemoryItem,
  OfficeFileInfo,
  RagHit,
  SceneHit,
  SkillInfo,
  SqlProfile,
  SqlProfileTest,
  UserInfo,
};

/** Frontend-only — role is stricter than backend (only "user"|"assistant", not generic "system") */
export type ChatMessageInfo = {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number | null;
};

export type KnowledgeIndexStatus = "not_indexed" | "indexing" | "ready" | "failed";
export interface KnowledgeContext {
  context: string;
  files: OfficeFileInfo[];
}
export const MEMORY_KINDS = ["preference", "rule", "event", "fact", "goal"] as const;

// ---- Frontend-local overrides for generated types ----

/** Frontend never sends null timestamps; backend returns them as i64 from DB. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export function codegraphExplore(query: string, projectPath?: string): Promise<CodegraphExploreResult> {
  return call<CodegraphExploreResult>("codegraph_explore", { query, projectPath: projectPath ?? null });
}

export function codegraphStatus(projectPath?: string): Promise<CodegraphStatusResult> {
  return call<CodegraphStatusResult>("codegraph_status", { projectPath: projectPath ?? null });
}

export function codegraphIsAvailable(): Promise<boolean> {
  return call<boolean>("codegraph_is_available");
}

export function codegraphInit(projectPath?: string): Promise<CodegraphStatusResult> {
  return call<CodegraphStatusResult>("codegraph_init", { projectPath: projectPath ?? null });
}

// ── TTS (piper-rs, feature "tts") ──────────────────────────────────────────

/**
 * Synthesize speech from text using the Piper neural TTS engine.
 * Returns base64-encoded WAV audio for playback.
 * @param text - Text to synthesize
 * @param voice - Voice id (optional, defaults to en_US-libritts_r-medium)
 * @param lengthScale - Speech speed (1.0 = normal, <1.0 = faster, >1.0 = slower)
 */
export function synthesizeSpeech(text: string, voice?: string, lengthScale?: number): Promise<string> {
  return call<string>("synthesize_speech", {
    text,
    voice: voice ?? null,
    lengthScale: lengthScale ?? null,
  });
}
