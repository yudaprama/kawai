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

// ---- Backend payload types (serde camelCase) ----

export interface UserInfo {
  userId: string;
}

/** Agent catalog entry from the `list_agents` op — the backend is the single
 *  source of truth for agent ids; the frontend never hardcodes them. */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  /** true → `agent_chat` with domain tools (office, cloud subagents); false → `agent_chat` with only a persona. */
  tools: boolean;
}

export interface ChatSessionInfo {
  id: number;
  agentId: string;
  title: string | null;
  createdAt: number | null;
  archived: boolean;
  archivedAt: number | null;
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

/** Probe result of `sql_profile_test` — `ok: false` carries the reason inline. */
export interface SqlProfileTest {
  ok: boolean;
  engine: string;
  tables: number;
  sample: string[];
  error: string | null;
}

/** List projection of a skill (SKILL.md body omitted) — mirror of `logic::skills::SkillSummary`. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** A stored skill including its SKILL.md body — mirror of `logic::skills::Skill`. */
export interface SkillInfo extends SkillSummary {
  content: string;
}

/** An L1 memory item — mirror of `logic::memory::MemoryItem`. */
export interface MemoryItem {
  id: string;
  kind: "preference" | "rule" | "event" | "fact" | "goal";
  title: string;
  content: string;
  sourceSessionId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** All valid memory kinds (kind filter in the Memory page). */
export const MEMORY_KINDS = ["preference", "rule", "event", "fact", "goal"] as const;

// ---- CodeGraph bridge (feature `codegraph`) ----

export interface CodegraphExploreResult {
  query: string;
  output: string;
  isError: boolean;
  backend: string;
}

export interface CodegraphStatusResult {
  available: boolean;
  backend: string;
  version: string | null;
  message: string;
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
