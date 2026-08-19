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

// ---- Backend payload types (serde camelCase) ----

export interface UserInfo {
  userId: string;
}

export interface ChatSessionInfo {
  id: number;
  agentId: string;
  title: string | null;
  createdAt: number | null;
}

export interface ChatMessageInfo {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number | null;
}

export interface LocalModelInfo {
  modelPath: string;
  backend: string;
}

export interface OfficeFileInfo {
  id: string;
  originalName: string;
  ext: string;
  bytes: number;
  createdAt: number;
}

export interface KnowledgeContext {
  context: string;
  files: OfficeFileInfo[];
}

/** RAG index lifecycle of one document (mirror of `rag::IndexStatus`). */
export type KnowledgeIndexStatus = "not_indexed" | "indexing" | "ready" | "failed";

/** Knowledge panel row: office store metadata + index state + session scope. */
export interface KnowledgeFileInfo {
  id: string;
  originalName: string;
  ext: string;
  bytes: number;
  createdAt: number;
  status: KnowledgeIndexStatus;
  chunks: number;
  error: string | null;
  inSession: boolean;
}

/** A retrieved RAG chunk with provenance, returned by `knowledge_search`. */
export interface RagHit {
  source: string;
  locator: string;
  content: string;
}
