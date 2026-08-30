/**
 * Local replacements for the `ai` (Vercel AI SDK) types used by the vendored
 * ai-elements components. kawai does not use the AI SDK at runtime — the chat
 * stream comes from the Tauri backend (`Channel<LocalChatEvent>`) and is mapped
 * into these UIMessage/part shapes by `hooks/use-supervisor-plan`. Type-only shim:
 * keep the field names compatible with AI SDK v5+ UIMessage semantics so the
 * vendored components keep working unmodified.
 */

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export type UIMessagePartState = "done" | "streaming";

export interface ProviderMetadata {
  [key: string]: unknown;
}

export interface UIMessageMetadata {
  [key: string]: unknown;
}

export interface TextUIPart {
  type: "text";
  text: string;
  state?: UIMessagePartState;
  providerMetadata?: ProviderMetadata;
}

export interface ReasoningUIPart {
  type: "reasoning";
  text: string;
  state?: UIMessagePartState;
  providerMetadata?: ProviderMetadata;
}

export interface FileUIPart {
  type: "file";
  mediaType: string;
  filename?: string;
  url: string;
  providerMetadata?: ProviderMetadata;
}

export interface SourceDocumentUIPart {
  type: "source-document";
  sourceId: string;
  mediaType?: string;
  title?: string;
  filename?: string;
  text?: string;
  url?: string;
  providerMetadata?: ProviderMetadata;
}

export interface SourceUrlUIPart {
  type: "source-url";
  url: string;
  title?: string;
  providerMetadata?: ProviderMetadata;
}

export type ToolUIPartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "approval-requested"
  | "approval-responded"
  | "output-denied";

interface ToolUIPartBase {
  toolCallId: string;
  state: ToolUIPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  providerMetadata?: ProviderMetadata;
}

export interface ToolUIPart extends ToolUIPartBase {
  type: `tool-${string}`;
}

export interface DynamicToolUIPart<TName extends string = string, TInput = unknown, TOutput = unknown>
  extends ToolUIPartBase {
  type: "dynamic-tool";
  toolName: TName;
  input?: TInput;
  output?: TOutput;
}

export type UIMessagePart =
  | TextUIPart
  | ReasoningUIPart
  | FileUIPart
  | SourceDocumentUIPart
  | SourceUrlUIPart
  | ToolUIPart
  | DynamicToolUIPart;

export interface UIMessage<PARTS extends UIMessagePart[] = UIMessagePart[]> {
  id: string;
  role: "system" | "user" | "assistant";
  metadata?: UIMessageMetadata;
  parts: PARTS;
}

/** Generated-image part payload (image.tsx). */
export interface Experimental_GeneratedImage {
  mediaType?: string;
  base64?: string;
  uint8Array?: Uint8Array;
  textPrompt?: string;
  warning?: string;
  providerOptions?: Record<string, unknown>;
}

/** Generated audio file payload (audio-player.tsx). */
export interface Experimental_GeneratedAudioFile {
  uint8Array?: Uint8Array;
  base64?: string;
  mediaType?: string;
}

/** Speech generation result (audio-player.tsx). */
export interface Experimental_SpeechResult {
  audio: Experimental_GeneratedAudioFile;
  transcript?: string;
  id?: string;
  mimeType?: string;
  sampleRate?: number;
  providerMetadata?: ProviderMetadata;
}

/** Transcription result (transcription.tsx). */
export interface Experimental_TranscriptionResult {
  transcriptType: "text" | "markdown";
  transcript: string;
  language?: string;
  durationSeconds?: number;
  segments: Array<{
    text: string;
    startSecond: number;
    endSecond: number;
    id?: number;
  }>;
}
