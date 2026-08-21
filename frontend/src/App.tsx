import { useCallback, useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { useCopyButton } from "@/hooks/use-copy-button";
import { useKnowledgeFiles } from "@/hooks/use-knowledge-files";
import { useLocalChat } from "@/hooks/use-local-chat";
import { platform, runningInTauri } from "@/platform";
import { call, errText, type AgentInfo, type KnowledgeFileInfo, type OfficeFileInfo } from "@/lib/api";
import { knowledgeFileToPreview } from "@/lib/preview-file";
import { FilePreview } from "@/components/file-preview";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UIMessage } from "@/lib/ai-types";
import {
  BriefcaseIcon,
  CheckIcon,
  BotIcon,
  CopyIcon,
  FileTextIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  SunIcon,
  TrashIcon,
  VideoIcon,
  XIcon,
  EyeIcon,
} from "lucide-react";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
} from "lucide-react";

/** Presentation for a catalog agent (from the `list_agents` op): the backend
 *  owns ids/names/descriptions; this map adds the icon, sidebar subtitle and
 *  suggested prompts. Unknown ids (new backend agents) fall back to a generic
 *  entry — adding an agent server-side is enough for it to appear. */
interface AgentPresentation {
  icon: typeof BriefcaseIcon;
  subtitle: string;
  prompts: string[];
}

const GENERIC_AGENT: AgentPresentation = {
  icon: BotIcon,
  subtitle: "agent",
  prompts: [],
};

const AGENT_META: Record<string, AgentPresentation> = {
  "builtin.chat": {
    icon: SparklesIcon,
    subtitle: "on-device assistant",
    prompts: ["How are you?", "Summarize my day", "Help me write an email"],
  },
  "builtin.office": {
    icon: BriefcaseIcon,
    subtitle: "docs · pdf · sheets",
    prompts: ["Summarize this PDF", "Create a weekly report", "Merge these invoices"],
  },
};

const agentPresentation = (id: string): AgentPresentation =>
  AGENT_META[id] ?? GENERIC_AGENT;

function MessagePartView({ message }: { message: UIMessage }) {
  const textPart = message.parts.find((p) => p.type === "text");
  const { handleCopy, copied } = useCopyButton(textPart?.text ?? "");

  const toolParts = message.parts.filter(
    (p): p is Extract<typeof p, { type: `tool-${string}` }> =>
      p.type.startsWith("tool-"),
  );

  return (
    <Message
      from={message.role}
      className={message.role === "assistant" ? "items-start" : undefined}
    >
      {toolParts.map((part) => {
        // Extract summary from the output wrapper { ok, summary }
        const output = part.output as { ok?: boolean; summary?: string } | undefined;
        const displayOutput = output?.summary ?? part.output;
        
        return (
          <Tool key={part.toolCallId}>
            <ToolHeader
              state={part.state}
              title={part.type.split("-").slice(1).join("-")}
              type={part.type}
            />
            <ToolContent>
              {part.input != null && <ToolInput input={part.input} />}
              {displayOutput != null && (
                <ToolOutput output={displayOutput} errorText={part.errorText} />
              )}
            </ToolContent>
          </Tool>
        );
      })}
      {textPart && textPart.text.length > 0 && (
        <MessageContent>
          <MessageResponse>{textPart.text}</MessageResponse>
        </MessageContent>
      )}
      {message.role === "assistant" && textPart && textPart.text.length > 0 && (
        <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <Button onClick={handleCopy} size="icon" variant="ghost">
            {copied ? <CheckIcon className="size-3.5 text-green-500" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
      )}
    </Message>
  );
}

/** Reads a File as a base64 string (chunked to survive large files). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        reject(new Error("Unexpected file read result"));
        return;
      }
      const bytes = new Uint8Array(result);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Tri-state theme switcher (Light / Dark / System). Client-only, persisted to
 * localStorage; the inline script in index.html applies it before paint. */
function ThemeControl({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const TriggerIcon = resolvedTheme === "dark" ? MoonIcon : SunIcon;
  const options: { value: Theme; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Change theme"
          size="icon"
          title="Appearance"
          variant="ghost"
        >
          <TriggerIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-36">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            className="gap-2"
          >
            <opt.icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{opt.label}</span>
            {theme === opt.value && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
      {!collapsed && (
        <span className="text-muted-foreground ml-2 truncate text-xs">Appearance</span>
      )}
    </DropdownMenu>
  );
}

/** Human-readable byte size ("1.2 MB", "840 B"). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Extensions accepted by the Files panel picker (office store + images). */
const ADD_FILE_ACCEPT = [".docx", ".xlsx", ".pptx", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
const OFFICE_EXTS = new Set(["docx", "xlsx", "pptx", "pdf"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** True when a URL is a YouTube watch/embed/share link. */
function isYouTubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

/** Decodes a `data:` URL back into a File (for routing pasted images into the
 * knowledge import pipeline). */
function dataUrlToFile(dataUrl: string, name: string): File {
  const [meta, b64] = dataUrl.split(",", 2);
  const mime = meta.slice(5, meta.indexOf(";")) || "application/octet-stream";
  const binary = atob(b64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

type KnowledgeSource =
  | { kind: "file"; name: string; sourcePath?: string; file?: File }
  | { kind: "unsupported"; name: string };

/** Classify a picked file into what the knowledge panel should do with it. */
function classifySource(name: string, src: { path?: string; file?: File }): KnowledgeSource {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (OFFICE_EXTS.has(ext) || IMAGE_EXTS.has(ext)) {
    return { kind: "file", name, ...(src.path ? { sourcePath: src.path } : { file: src.file }) };
  }
  return { kind: "unsupported", name };
}

/** RAG index state shown under a document's name ("Indexing…", "12 chunks", …). */
function KnowledgeStatusBadge({ file }: { file: KnowledgeFileInfo }) {
  if (file.status === "indexing") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <Spinner className="size-3" />
        Indexing…
      </span>
    );
  }
  if (file.status === "failed") {
    return (
      <span className="text-destructive text-xs" title={file.error ?? undefined}>
        Index failed
      </span>
    );
  }
  if (file.status === "ready") {
    return file.chunks > 0 ? (
      <span className="text-muted-foreground text-xs">{file.chunks} chunks</span>
    ) : (
      <span className="text-muted-foreground/70 text-xs" title="No extractable text found">
        no text
      </span>
    );
  }
  return <span className="text-muted-foreground/70 text-xs">not indexed</span>;
}

/** Knowledge panel section label with a right-aligned item count. */
function KnowledgeSectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between px-1 pb-1.5">
      <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </p>
      <span className="font-mono text-[11px] text-muted-foreground/70">{count}</span>
    </div>
  );
}

/** One knowledge-panel document row: name, size/date/index state + scope
 * actions (add/remove to the active session, retry, delete). */
function KnowledgeFileRow({
  file,
  inSessionList,
  confirmDelete,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
  onPreview,
}: {
  file: KnowledgeFileInfo;
  inSessionList: boolean;
  confirmDelete: boolean;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
  onPreview: (file: KnowledgeFileInfo) => void;
}) {
  return (
    <div className="bg-card group/file flex items-center gap-2.5 rounded-lg border px-2.5 py-2">
      {inSessionList ? (
        <CheckIcon className="text-green-500 size-4 shrink-0" />
      ) : (
        <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <button
          className="block w-full truncate text-left text-sm hover:underline"
          onClick={() => onPreview(file)}
          title={`Preview ${file.originalName}`}
          type="button"
        >
          {file.originalName}
        </button>
        <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span>{formatBytes(file.bytes)}</span>
          <span aria-hidden>·</span>
          <span>{new Date(file.createdAt * 1000).toLocaleDateString()}</span>
          <span aria-hidden>·</span>
          <KnowledgeStatusBadge file={file} />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/file:opacity-100">
        <button
          aria-label={`Preview ${file.originalName}`}
          className="text-muted-foreground hover:text-foreground rounded p-1"
          onClick={() => onPreview(file)}
          title="Preview file"
          type="button"
        >
          <EyeIcon className="size-3.5" />
        </button>
        {file.status === "failed" && (
          <button
            aria-label={`Retry indexing ${file.originalName}`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => onRetry(file)}
            title={file.error ? `Retry indexing — last error: ${file.error}` : "Retry indexing"}
            type="button"
          >
            <RotateCcwIcon className="size-3.5" />
          </button>
        )}
        {inSessionList ? (
          <button
            aria-label={`Remove ${file.originalName} from this session`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => onRemove(file)}
            title="Remove from this session — the agent stops searching it here"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : (
          <button
            aria-label={`Add ${file.originalName} to this session`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => onAdd(file)}
            title="Add to this session — makes this document searchable by the agent in this chat"
            type="button"
          >
            <PlusIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-label={`Delete ${file.originalName}`}
          className={`rounded p-1 ${
            confirmDelete ? "text-destructive" : "text-muted-foreground hover:text-destructive"
          }`}
          onClick={() => onDelete(file)}
          title={confirmDelete ? "Click again to confirm — deletes the document everywhere" : "Delete document"}
          type="button"
        >
          <TrashIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The composer (text + speech only — images and documents live in the
 * knowledge panel; pasted images are routed there via `onImageToKnowledge`). */
function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ReturnType<typeof useLocalChat>["status"];
  onStop: () => void;
  onSubmit: (text: string) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  return (
    <PromptInputProvider>
      <ChatComposerInner
        agentName={agentName}
        onStop={onStop}
        status={status}
        onSubmit={onSubmit}
        onImageToKnowledge={onImageToKnowledge}
      />
    </PromptInputProvider>
  );
}

function ChatComposerInner({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ReturnType<typeof useLocalChat>["status"];
  onStop: () => void;
  onSubmit: (text: string) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  const controller = usePromptInputController();

  const handleTranscription = useCallback(
    (transcript: string) => {
      // Append recognized speech to the current draft, separated by a space.
      controller.textInput.setInput(
        (controller.textInput.value.trimEnd() + " " + transcript).trimStart(),
      );
    },
    [controller]
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      // The vendored textarea still captures pasted images into attachment
      // state; the knowledge panel is the single home for images, so route
      // them there instead of dropping them silently.
      for (const file of message.files) {
        if (file.mediaType.startsWith("image/") && file.url.startsWith("data:")) {
          onImageToKnowledge(file.url, file.fileName ?? "pasted-image");
        }
      }
      if (message.text.trim()) onSubmit(message.text);
    },
    [onImageToKnowledge, onSubmit],
  );

  return (
    <PromptInput
      className="mx-auto max-w-2xl [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:gap-1 [&_[data-slot=input-group]]:overflow-visible [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:px-2 [&_[data-slot=input-group]]:py-1.5"
      onSubmit={handleSubmit}
    >
      <PromptInputBody>
        <PromptInputTextarea placeholder={`Message ${agentName}…`} />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <SpeechInput
            className="size-8 [&_svg]:size-4"
            onTranscriptionChange={handleTranscription}
          />
        </PromptInputTools>
        <PromptInputSubmit onStop={onStop} status={status} />
      </PromptInputFooter>
    </PromptInput>
  );
}

export default function App() {
  // Agent catalog comes from the backend (`list_agents`) — ids are never
  // hardcoded here. Until it arrives the UI shows a loading shell.
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentsRail, setAgentsRail] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);

  useEffect(() => {
    let disposed = false;
    call<AgentInfo[]>("list_agents")
      .then((catalog) => {
        if (!disposed && catalog.length) setAgents(catalog);
      })
      .catch((err) => console.error("[list_agents]", errText(err)));
    return () => {
      disposed = true;
    };
  }, []);

  // First catalog entry is the default agent (backend order = UI order).
  useEffect(() => {
    if (agents.length && activeAgentId == null) setActiveAgentId(agents[0].id);
  }, [agents, activeAgentId]);

  const agent =
    (activeAgentId != null && agents.find((a) => a.id === activeAgentId)) || agents[0] || null;
  const presentation = agent ? agentPresentation(agent.id) : GENERIC_AGENT;
  const chat = useLocalChat(agent ?? { id: "", tools: false });
  const { status } = chat;
  const busy = status === "submitted" || status === "streaming";
  const inSession = chat.sessionId != null || chat.messages.length > 0;

  const knowledge = useKnowledgeFiles(true);
  const sessionFiles =
    chat.sessionId != null ? knowledge.files.filter((f) => f.inSession) : [];
  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<KnowledgeFileInfo | null>(null);

  /** Two-step delete confirm auto-dismisses after 3s. */
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  /** Shared import + tracked-index pipeline for documents and images. */
  const importKnowledgeFiles = useCallback(
    async (items: { sourcePath?: string; file?: File; name: string }[]) => {
      const importedIds: string[] = [];
      for (const item of items) {
        let imported: OfficeFileInfo | undefined;
        if (item.sourcePath) {
          imported = await call<OfficeFileInfo>("office_import_file", { sourcePath: item.sourcePath });
        } else if (item.file) {
          const dataBase64 = await fileToBase64(item.file);
          imported = await call<OfficeFileInfo>("office_import_file", { dataBase64, name: item.name });
        }
        if (imported?.id) importedIds.push(imported.id);
      }
      if (importedIds.length) {
        // Tracked RAG indexing; associates the files with the active session
        // so the agent's knowledge_search sees them. The runs are dispatched
        // first (the backend records `indexing` immediately), then the list
        // refresh shows the new files — patched optimistically so no refresh
        // can race the status writes and flash "not indexed".
        const runs = importedIds.map((fileId) =>
          call<number>("office_index_file", {
            sessionId: chat.sessionId,
            fileId,
          })
            .catch((e) => console.warn("[office_index_file]", errText(e)))
            .finally(() => void knowledge.refresh()),
        );
        await knowledge.refresh();
        knowledge.markIndexing(importedIds);
        void Promise.allSettled(runs);
      }
    },
    [chat.sessionId, knowledge],
  );

  /**
   * Imports picked documents/images into the knowledge base. In Tauri the
   * native dialog returns absolute paths (imported via `sourcePath`); in a
   * plain browser we fall back to `File` → base64. Everything is indexed
   * (RAG) and associated with the active session — the agent then finds it
   * via its `knowledge_search` tool. Indexing is tracked: the row shows
   * `Indexing…` immediately and settles to chunks/failed on refresh.
   */
  const addKnowledgeFiles = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    const toImport: { sourcePath?: string; file?: File; name: string }[] = [];
    let picked: KnowledgeSource[];
    try {
      if (runningInTauri) {
        const paths = await platform.pickFilePaths({ accept: ADD_FILE_ACCEPT, multiple: true });
        if (!paths?.length) return;
        picked = paths.map((p) =>
          classifySource(p.split(/[\\/]/).pop() ?? p, { path: p }),
        );
      } else {
        const pickedFiles = await platform.pickFiles({
          accept: ADD_FILE_ACCEPT,
          multiple: true,
        });
        if (!pickedFiles?.length) return;
        picked = pickedFiles.map((f) => classifySource(f.name, { file: f }));
      }
      for (const item of picked) {
        if (item.kind === "file") {
          toImport.push({ name: item.name, sourcePath: item.sourcePath, file: item.file });
        } else {
          setImportError(`Unsupported file type: ${item.name}`);
        }
      }
      await importKnowledgeFiles(toImport);
    } catch (err) {
      console.warn("[office_import_file]", errText(err));
      setImportError(errText(err));
    } finally {
      setImporting(false);
    }
  }, [importKnowledgeFiles]);

  /** Pasted-image entry from the composer → the knowledge base (the single
   * home for images). Derives the extension from the data-URL mime type. */
  const imageToKnowledge = useCallback(
    async (dataUrl: string, name: string) => {
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      const ext = mime.split("/")[1] ?? "png";
      try {
        await importKnowledgeFiles([
          { name: `${name}.${ext}`, file: dataUrlToFile(dataUrl, `${name}.${ext}`) },
        ]);
      } catch (err) {
        setImportError(errText(err));
      }
    },
    [importKnowledgeFiles],
  );

  /** Add a library document to the active session (indexes it if needed). */
  const addToSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (chat.sessionId == null) return;
      knowledge.markInSession([file.id], true);
      if (file.chunks === 0 || file.status === "failed") knowledge.markIndexing([file.id]);
      try {
        await call<number>("knowledge_add_to_session", {
          sessionId: chat.sessionId,
          fileIds: [file.id],
        });
      } catch (err) {
        setImportError(errText(err));
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  /** Disassociate a document from the active session (orphaned chunks are
   * purged by the backend). */
  const removeFromSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (chat.sessionId == null) return;
      knowledge.markInSession([file.id], false);
      try {
        await call<number>("knowledge_forget", {
          sessionId: chat.sessionId,
          fileIds: [file.id],
        });
      } catch (err) {
        setImportError(errText(err));
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  /** Re-run indexing for a failed document. */
  const retryIndex = useCallback(
    async (file: KnowledgeFileInfo) => {
      knowledge.markIndexing([file.id]);
      try {
        await call<number>("office_index_file", {
          sessionId: chat.sessionId,
          fileId: file.id,
        });
      } catch (err) {
        // The row's `failed` status (after refresh) surfaces the cause.
        console.warn("[office_index_file]", errText(err));
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  /** Delete a document everywhere; first click arms, second click confirms. */
  const deleteFile = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (confirmDeleteId !== file.id) {
        setConfirmDeleteId(file.id);
        return;
      }
      setConfirmDeleteId(null);
      knowledge.remove([file.id]);
      try {
        await call("office_delete_file", { fileId: file.id });
      } catch (err) {
        setImportError(errText(err));
        await knowledge.refresh();
      }
    },
    [confirmDeleteId, knowledge],
  );

  /** Opens the inline preview for a knowledge document. */
  const openPreview = useCallback((file: KnowledgeFileInfo) => {
    setPreviewFile(file);
  }, []);

  /** Prompts for a YouTube URL and ingests its transcript into the knowledge
   * base (fetch → markdown document → indexed, deduped per video). */
  const addKnowledgeLink = useCallback(async () => {
    setImportError(null);
    const url = await platform.promptForUrl("Paste a YouTube video URL");
    if (!url) return;
    if (!isYouTubeUrl(url)) {
      setImportError("Only YouTube URLs are supported for now");
      return;
    }
    setLinking(true);
    try {
      await call<OfficeFileInfo>("knowledge_import_youtube", {
        url,
        sessionId: chat.sessionId,
      });
      await knowledge.refresh();
    } catch (err) {
      console.warn("[knowledge_import_youtube]", errText(err));
      setImportError(errText(err));
    } finally {
      setLinking(false);
    }
  }, [chat.sessionId, knowledge.refresh]);

  // Switching agent clears the model context + active session.
  useEffect(() => {
    void chat.selectAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  // Track session changes so the files panel shows "In this session" correctly.
  useEffect(() => {
    knowledge.setSessionId(chat.sessionId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.sessionId]);

  // Pane shortcuts: ⌘1 agents rail, ⌘2 canvas, ⌘3 sessions pane, ⌘N new session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        setAgentsRail((v) => !v);
      } else if (e.key === "2") {
        e.preventDefault();
        setCanvasOpen((v) => !v);
      } else if (e.key === "3") {
        e.preventDefault();
        setSessionsCollapsed((v) => !v);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (!busy) void chat.newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, chat]);

  // Catalog not loaded yet — all hooks above have run; render a quiet shell.
  if (!agent) {
    return <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center" />;
  }

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
      {/* ══════════ PANE 1: AGENTS ══════════ */}
      <aside
        className={`bg-sidebar/40 hidden shrink-0 flex-col border-r transition-[width] duration-150 md:flex ${
          agentsRail ? "w-16" : "w-[210px]"
        }`}
      >
        <div
          className={`flex h-12 shrink-0 items-center gap-2 px-3 ${agentsRail ? "justify-center px-0" : ""}`}
        >
          {!agentsRail && <span className="font-mono text-xs text-muted-foreground">kawai</span>}
          <Button
            className={agentsRail ? "" : "ml-auto"}
            onClick={() => setAgentsRail((v) => !v)}
            size="icon"
            title="Toggle agents rail (⌘1)"
            variant="ghost"
          >
            {agentsRail ? <PanelLeftOpenIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
          </Button>
        </div>

        {!agentsRail && (
          <p className="px-3 pt-2 pb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">
            Agents
          </p>
        )}

        <nav className={`flex flex-col gap-1 ${agentsRail ? "px-1.5" : "px-2"}`}>
          {agents.map((a) => {
            const meta = agentPresentation(a.id);
            const Icon = meta.icon;
            const active = a.id === activeAgentId;
            return (
              <button
                className={`flex w-full items-center rounded-lg text-left transition-colors ${
                  agentsRail ? "justify-center p-2" : "gap-2.5 px-2.5 py-2"
                } ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                key={a.id}
                onClick={() => setActiveAgentId(a.id)}
                title={`${a.name} · ${meta.subtitle}`}
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                    active ? "bg-background/60" : "bg-muted"
                  }`}
                >
                  <Icon className="size-[15px]" />
                </span>
                {!agentsRail && (
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm leading-tight font-medium">{a.name}</span>
                    <span className="text-muted-foreground truncate text-xs leading-tight">
                      {meta.subtitle}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div
          className={`mt-auto flex items-center gap-2.5 border-t p-3 ${agentsRail ? "flex-col p-1.5" : ""}`}
        >
          <span className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
            {(chat.userId ?? "d").charAt(0).toUpperCase()}
          </span>
          {agentsRail ? (
            <ThemeControl collapsed />
          ) : (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-muted-foreground">
                {chat.userId ?? "demo"}
              </span>
              <ThemeControl collapsed={false} />
            </div>
          )}
        </div>
      </aside>

      {/* ══════════ PANE 2: WORKSPACE ══════════ */}
      <main className="bg-background flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
          <span className="truncate text-sm font-medium">
            {inSession
              ? (chat.sessions.find((s) => s.id === chat.sessionId)?.title ?? `${agent.name} agent`)
              : `${agent.name} agent`}
          </span>
          {chat.modelLoading && (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <Spinner className="size-3" />
              warming up
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              onClick={() => setCanvasOpen((v) => !v)}
              size="icon"
              title="Toggle canvas (⌘2)"
              variant={canvasOpen ? "ghost" : "secondary"}
            >
              <PanelRightIcon className="size-4" />
            </Button>
            <Button
              onClick={() => setSessionsCollapsed((v) => !v)}
              size="icon"
              title="Toggle sessions pane (⌘3)"
              variant="ghost"
            >
              {sessionsCollapsed ? <PanelRightOpenIcon className="size-4" /> : <PanelRightCloseIcon className="size-4" />}
            </Button>
          </div>
        </header>

        {chat.modelError && (
          <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 rounded-md border px-3 py-2 text-sm">
            {chat.modelStatus}
          </div>
        )}
        {chat.error && (
          <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 rounded-md border px-3 py-2 text-sm">
            {chat.error}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* conversation / agent overview */}
          <section
            className={`flex min-w-0 flex-col ${canvasOpen ? "md:w-[55%] md:flex-none" : "w-full"}`}
          >
            <div className="relative min-h-0 flex-1">
              {!inSession ? (
                <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <span className="bg-primary/15 text-primary flex size-12 items-center justify-center rounded-xl">
                    <presentation.icon className="size-6" />
                  </span>
                  <h2 className="text-lg font-semibold text-foreground">{agent.name} agent</h2>
                  <p className="-mt-1 text-sm">{agent.description}</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {presentation.prompts.map((prompt) => (
                      <button
                        className="border bg-card hover:bg-accent rounded-full border px-3 py-1 text-xs"
                        key={prompt}
                        onClick={() => void chat.send(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <Conversation className="h-full">
                  <ConversationContent className="mx-auto max-w-2xl px-4 pt-6 pb-4">
                    {chat.messages.map((message) => (
                      <MessagePartView key={message.id} message={message} />
                    ))}
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>
              )}
            </div>

            {/* composer */}
            <div className="shrink-0 px-4 pb-4">
              <ChatComposer
                agentName={agent.name}
                onStop={chat.stop}
                status={status}
                onSubmit={(text) => void chat.send(text)}
                onImageToKnowledge={(dataUrl, name) => void imageToKnowledge(dataUrl, name)}
              />
            </div>
          </section>

          {/* canvas */}
          {canvasOpen && (
            <section className="hidden min-w-0 flex-1 flex-col border-l md:flex">
              <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3">
                <span className="text-sm font-medium">Knowledge</span>
                <div className="flex items-center gap-1">
                  <Button
                    disabled={linking || importing}
                    onClick={() => void addKnowledgeLink()}
                    size="xs"
                    title="Ingest a YouTube video transcript into your knowledge base"
                    variant="ghost"
                  >
                    {linking ? <Spinner className="size-3" /> : <VideoIcon className="size-3" />}
                    Link
                  </Button>
                  <Button
                    disabled={importing || linking}
                    onClick={() => void addKnowledgeFiles()}
                    size="xs"
                    title="Import documents & images (.docx .xlsx .pptx .pdf .png .jpg …)"
                    variant="ghost"
                  >
                    {importing ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />}
                    Add files
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {importError && (
                  <div className="text-destructive border-destructive/40 bg-destructive/10 mx-3 mt-3 rounded-md border px-3 py-2 text-xs">
                    {importError}
                  </div>
                )}
                <div className="p-3 pt-5">
                  {knowledge.unavailable ? (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                      <FileTextIcon className="text-muted-foreground/40 mb-3 size-5" />
                      <p className="text-muted-foreground text-sm">Knowledge store unavailable</p>
                      <p className="text-muted-foreground/70 mt-1 text-xs">
                        The office feature isn&apos;t enabled in this build
                      </p>
                    </div>
                  ) : !knowledge.loaded ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                      <Spinner className="size-4" />
                      Loading knowledge…
                    </div>
                  ) : (
                    <div className="flex flex-col gap-5">
                      {chat.sessionId != null && (
                        <div>
                          <KnowledgeSectionLabel
                            count={sessionFiles.length}
                            label="In this session"
                          />
                          {sessionFiles.length > 0 ? (
                            <>
                              <div className="flex flex-col gap-1.5">
                                {sessionFiles.map((file) => (
                                  <KnowledgeFileRow
                                    confirmDelete={confirmDeleteId === file.id}
                                    file={file}
                                    inSessionList
                                    key={file.id}
                                    onAdd={addToSession}
                                    onDelete={deleteFile}
                                    onPreview={openPreview}
                                    onRemove={removeFromSession}
                                    onRetry={retryIndex}
                                  />
                                ))}
                              </div>
                              <p className="text-muted-foreground/70 mt-1.5 px-1 text-xs">
                                The agent can search these documents in this chat.
                              </p>
                            </>
                          ) : (
                            <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-xs">
                              No documents in this session yet — press{" "}
                              <span className="font-medium">+</span> on a library document
                              below, or import new files; the agent can then search them in
                              this chat.
                            </div>
                          )}
                        </div>
                      )}
                      <div>
                        <KnowledgeSectionLabel
                          count={knowledge.files.length}
                          label={chat.sessionId != null ? "Library" : "Documents"}
                        />
                        {knowledge.files.length === 0 ? (
                          <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-xs">
                            No sources yet — import .docx, .xlsx, .pptx, .pdf or images with
                            "Add files", or paste a YouTube link with "Link".
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {knowledge.files.map((file) => (
                              <KnowledgeFileRow
                                confirmDelete={confirmDeleteId === file.id}
                                file={file}
                                inSessionList={file.inSession && chat.sessionId != null}
                                key={file.id}
                                onAdd={addToSession}
                                onDelete={deleteFile}
                                onPreview={openPreview}
                                onRemove={removeFromSession}
                                onRetry={retryIndex}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </main>

      {/* ══════════ PANE 3: SESSIONS ══════════ */}
      {!sessionsCollapsed && (
        <aside className="bg-sidebar/40 hidden w-[240px] shrink-0 flex-col border-l md:flex">
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
            <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
              Sessions
            </span>
            <Button disabled={busy} onClick={() => void chat.newChat()} size="xs" variant="default">
              <PlusIcon className="size-3" />
              New
            </Button>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
            {chat.groupedSessions.map((group) => (
              <div key={group.label}>
                <p className="text-muted-foreground px-2.5 pb-1.5 font-mono text-[11px] tracking-wider uppercase">
                  {group.label}
                </p>
                <div className="flex flex-col gap-0.5">
                  {group.sessions.map((session) => (
                    <div
                      className={`group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                        chat.sessionId === session.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                      key={session.id}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => void chat.selectSession(session.id)}
                        type="button"
                      >
                        {chat.sessionId === session.id && (
                          <span className="bg-primary size-1.5 shrink-0 rounded-full" />
                        )}
                        <span className="truncate">{session.title || `Session #${session.id}`}</span>
                      </button>
                      <button
                        aria-label={`Delete ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 transition-opacity group-hover/session:opacity-100"
                        onClick={() => void chat.deleteSession(session.id)}
                        title="Delete session"
                        type="button"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          </aside>
        )}

        <Dialog open={previewFile != null} onOpenChange={(open) => !open && setPreviewFile(null)}>
          <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
            <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b px-4 py-3">
              <DialogTitle className="truncate text-sm font-medium">
                {previewFile?.originalName}
              </DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col bg-background">
              {previewFile && <FilePreview file={knowledgeFileToPreview(previewFile)} />}
            </div>
          </DialogContent>
        </Dialog>
      </div>
  );
}
