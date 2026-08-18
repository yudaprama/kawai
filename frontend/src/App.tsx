import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  LocalReferencedSourcesContext,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
  usePromptInputReferencedSources,
  type ReferencedSourcesContext,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCopyButton } from "@/hooks/use-copy-button";
import { useKnowledgeFiles } from "@/hooks/use-knowledge-files";
import { useLocalChat } from "@/hooks/use-local-chat";
import { platform, runningInTauri } from "@/platform";
import { call, errText, type KnowledgeContext, type OfficeFileInfo, type RagHit } from "@/lib/api";
import type { SourceDocumentUIPart, UIMessage } from "@/lib/ai-types";
import {
  BookOpenIcon,
  BriefcaseIcon,
  CheckIcon,
  CloudSunIcon,
  CopyIcon,
  FileTextIcon,
  ImageIcon,
  LineChartIcon,
  PlusIcon,
  Plus,
  VideoIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  icon: typeof BriefcaseIcon;
  subtitle: string;
  description: string;
  prompts: string[];
}

const AGENTS: Agent[] = [
  {
    id: "office",
    name: "Office",
    icon: BriefcaseIcon,
    subtitle: "docs · pdf · sheets",
    description: "Documents, PDFs, spreadsheets — created and edited locally",
    prompts: ["Summarize this PDF", "Create a weekly report", "Merge these invoices"],
  },
  {
    id: "finance",
    name: "Finance",
    icon: LineChartIcon,
    subtitle: "markets & budgets",
    description: "Markets, budgets, and financial analysis",
    prompts: ["Analyze my portfolio", "Create a budget", "Compare Q3 vs Q2"],
  },
  {
    id: "knowledge",
    name: "Knowledge",
    icon: BookOpenIcon,
    subtitle: "notes & recall",
    description: "Notes, research, and knowledge recall",
    prompts: ["Search my notes", "Create a research brief", "Summarize this article"],
  },
  {
    id: "weather",
    name: "Weather",
    icon: CloudSunIcon,
    subtitle: "forecasts & alerts",
    description: "Forecasts, alerts, and weather insights",
    prompts: ["Weekend forecast", "Rain alert for commute", "Best travel days"],
  },
];

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
        const output = part.output as { ok?: boolean; summary?: string } | undefined;
        return (
          <Tool key={part.toolCallId}>
            <ToolHeader
              state={part.state}
              title={part.type.split("-").slice(1).join("-")}
              type={part.type}
            />
            <ToolContent>
              {part.input != null && (
                <pre className="text-muted-foreground max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-xs">
                  {JSON.stringify(part.input, null, 2)}
                </pre>
              )}
              {output && (
                <p className={output.ok ? "text-xs" : "text-destructive text-xs"}>
                  {output.summary}
                </p>
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

/** Extracts the raw base64 payload (no data: prefix) from a data URL. */
function dataUrlB64(url: string): string | null {
  const i = url.indexOf(",");
  if (!url.startsWith("data:") || i === -1) return null;
  return url.slice(i + 1);
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

/** Extracts the 11-char YouTube video id from a URL (or null). */
function youtubeId(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.hostname.toLowerCase() === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id?.length === 11 ? id : null;
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

type KnowledgeSource = { kind: "office"; name: string; sourcePath?: string; file?: File } | { kind: "image"; name: string } | { kind: "unsupported"; name: string };

/** Classify a picked file into what the Files panel should do with it. */
function classifySource(name: string, src: { path?: string; file?: File }): KnowledgeSource {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (OFFICE_EXTS.has(ext)) {
    return { kind: "office", name, ...(src.path ? { sourcePath: src.path } : { file: src.file }) };
  }
  if (IMAGE_EXTS.has(ext)) return { kind: "image", name };
  return { kind: "unsupported", name };
}

/** The composer with attachments + knowledge @-mention. */
type KnowledgeFiles = ReturnType<typeof useKnowledgeFiles>;

function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  knowledge,
}: {
  agentName: string;
  status: ReturnType<typeof useLocalChat>["status"];
  onStop: () => void;
  onSubmit: (text: string, imageB64?: string, knowledgeContext?: string) => void;
  knowledge: KnowledgeFiles;
}) {
  return (
    <PromptInputProvider>
      <ChatComposerSources>
        <ChatComposerInner
          agentName={agentName}
          knowledge={knowledge}
          onStop={onStop}
          status={status}
          onSubmit={onSubmit}
        />
      </ChatComposerSources>
    </PromptInputProvider>
  );
}

/** Provides the referenced-sources context that ChatComposerInner reads. */
function ChatComposerSources({ children }: { children: React.ReactNode }) {
  const [sources, setSources] = useState<(SourceDocumentUIPart & { id: string })[]>([]);

  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      sources,
      add: (incoming) => {
        const arr = Array.isArray(incoming) ? incoming : [incoming];
        setSources((prev) => [
          ...prev,
          ...arr.map((s) => ({ ...s, id: nanoid() })),
        ]);
      },
      remove: (id) => setSources((prev) => prev.filter((s) => s.id !== id)),
      clear: () => setSources([]),
    }),
    [sources],
  );

  return (
    <LocalReferencedSourcesContext.Provider value={refsCtx}>
      {children}
    </LocalReferencedSourcesContext.Provider>
  );
}

/** Matches a trailing @query token ("see @invoic" → "invoic"). */
const TRAILING_MENTION = /(^|\s)@([\p{L}\p{N}._-]*)$/u;

function ChatComposerInner({
  agentName,
  status,
  onStop,
  onSubmit,
  knowledge,
}: {
  agentName: string;
  status: ReturnType<typeof useLocalChat>["status"];
  onStop: () => void;
  onSubmit: (text: string, imageB64?: string, knowledgeContext?: string) => void;
  knowledge: KnowledgeFiles;
}) {
  const attachments = usePromptInputAttachments();
  const sources = usePromptInputReferencedSources();
  const controller = usePromptInputController();
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const { files, loaded, unavailable, refresh } = knowledge;

  const text = controller.textInput.value ?? "";

  const filtered = useMemo(() => {
    const q = mentionQuery.toLowerCase();
    return files
      .filter((f) => f.originalName.toLowerCase().includes(q))
      .slice(0, 6);
  }, [files, mentionQuery]);

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.currentTarget.value;
      const m = TRAILING_MENTION.exec(value);
      if (m) {
        setMentionOpen(true);
        setMentionQuery(m[2]);
      } else {
        setMentionOpen(false);
      }
    },
    [],
  );

  const selectMention = useCallback(
    (file: { id: string; originalName: string }) => {
      sources.add({
        type: "source-document",
        sourceId: file.id,
        title: file.originalName,
        mediaType: "text/markdown",
      });
      // Strip the trailing @token from the draft.
      controller.textInput.setInput(text.replace(TRAILING_MENTION, "$1"));
      setMentionOpen(false);
    },
    [sources, controller, text],
  );

  const handleTranscription = useCallback(
    (transcript: string) => {
      // Append recognized speech to the current draft, separated by a space.
      controller.textInput.setInput(
        (controller.textInput.value.trimEnd() + " " + transcript).trimStart()
      );
    },
    [controller]
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string }[] }) => {
      const image = message.files.find((f) => f.mediaType.startsWith("image/"));
      const imageB64 =
        image && image.url.startsWith("data:") ? (dataUrlB64(image.url) ?? undefined) : undefined;

      let context: string | undefined;
      const sourceIds = sources.sources.map((s) => s.sourceId);
      if (sourceIds.length > 0) {
        // Prefer instant vector retrieval over the slow full-text path.
        try {
          const hits = await call<RagHit[]>("knowledge_search", {
            fileIds: sourceIds,
            query: message.text,
          });
          if (hits.length) {
            context = hits
              .map((h) => `【${h.source}】\n${h.content}`)
              .join("\n\n---\n\n");
          }
        } catch (err) {
          console.warn("[knowledge_search]", errText(err));
        }
        // Fallback to lazy extraction when nothing is indexed yet.
        if (!context) {
          try {
            const kc = await call<KnowledgeContext>("knowledge_context", { fileIds: sourceIds });
            context = kc.context || undefined;
          } catch (err) {
            console.error("[knowledge_context]", errText(err));
          }
        }
      }

      if (message.text.trim() || imageB64 || context) onSubmit(message.text, imageB64, context);
      sources.clear();
    },
    [sources, onSubmit],
  );

  return (
    <PromptInput
      className="mx-auto max-w-2xl [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:gap-1 [&_[data-slot=input-group]]:overflow-visible [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:px-2 [&_[data-slot=input-group]]:py-1.5"
      globalDrop
      multiple
      onSubmit={handleSubmit}
    >
      <PromptInputHeader>
        {(attachments.files.length > 0 || sources.sources.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
            <Attachments variant="inline">
              {attachments.files.map((attachment) => (
                <Attachment
                  data={attachment}
                  key={attachment.id}
                  onRemove={() => attachments.remove(attachment.id)}
                >
                  <AttachmentPreview />
                  <AttachmentRemove />
                </Attachment>
              ))}
            </Attachments>
            {sources.sources.map((source) => (
              <span
                className="bg-muted text-muted-foreground inline-flex max-w-[200px] items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                key={source.id}
              >
                <FileTextIcon className="size-3 shrink-0" />
                <span className="truncate">{source.title || source.sourceId}</span>
                <button
                  aria-label={`Remove ${source.title}`}
                  className="hover:text-foreground shrink-0"
                  onClick={() => {
                    sources.remove(source.id);
                    // Drop the idle-indexed chunks for this file; they are
                    // cheaply rebuilt during idle time if mentioned again.
                    void call<number>("knowledge_forget", {
                      fileIds: [source.sourceId],
                    }).catch((e) => console.warn("[knowledge_forget]", errText(e)));
                  }}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </PromptInputHeader>
      <PromptInputBody>
        <div className="relative w-full">
          <PromptInputTextarea
            onChange={handleTextareaChange}
            placeholder={`Message ${agentName}… (@ to reference a document)`}
          />
          {mentionOpen && (
            <div className="bg-popover text-popover-foreground absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-lg border shadow-lg">
              {filtered.length > 0 ? (
                filtered.map((file) => (
                  <button
                    className="hover:bg-accent flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
                    key={file.id}
                    onClick={() => selectMention(file)}
                    type="button"
                  >
                    <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{file.originalName}</span>
                    <span className="text-muted-foreground ml-auto text-[10px] uppercase">
                      {file.ext}
                    </span>
                  </button>
                ))
              ) : (
                <button
                  className="text-muted-foreground w-full px-2.5 py-2 text-left text-xs"
                  onClick={() => setMentionOpen(false)}
                  type="button"
                >
                  {unavailable || !loaded
                    ? "No knowledge base (office feature off?)"
                    : `No documents matching “${mentionQuery}”`}
                </button>
              )}
            </div>
          )}
        </div>
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger>
              <Plus className="size-4" />
            </PromptInputActionMenuTrigger>
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments label="Add photos or files" />
              <PromptInputActionAddScreenshot label="Take screenshot" />
              <PromptInputActionMenuItem
                onSelect={() => {
                  void refresh();
                  controller.textInput.setInput(text.endsWith(" ") || !text ? `${text}@` : `${text} @`);
                }}
              >
                <FileTextIcon className="mr-2 size-4" /> Reference document
              </PromptInputActionMenuItem>
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
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
  const [activeAgentId, setActiveAgentId] = useState(AGENTS[0].id);
  const [agentsRail, setAgentsRail] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [canvasTab, setCanvasTab] = useState<"artifact" | "files">("artifact");

  const agent = AGENTS.find((a) => a.id === activeAgentId) ?? AGENTS[0];
  const chat = useLocalChat(agent.id);
  const { status } = chat;
  const busy = status === "submitted" || status === "streaming";
  const inSession = chat.sessionId != null || chat.messages.length > 0;

  const knowledge = useKnowledgeFiles(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: "image" | "link"; name: string; url?: string }[]>([]);

  /**
 * Imports picked documents/images into the knowledge store. In Tauri the
 * native dialog returns absolute paths (imported via `sourcePath`); in a
 * plain browser we fall back to `File` → base64.
 */
  const addKnowledgeFiles = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    const toImportOffice: { sourcePath?: string; file?: File; name: string }[] = [];
    const toPending: { id: string; kind: "image" | "link"; name: string }[] = [];
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
        if (item.kind === "office") {
          toImportOffice.push({ name: item.name, sourcePath: item.sourcePath, file: item.file });
        } else if (item.kind === "image") {
          toPending.push({ id: nanoid(), kind: "image", name: item.name });
        } else {
          setImportError(`Unsupported file type: ${item.name}`);
        }
      }
      for (const item of toImportOffice) {
        let imported: OfficeFileInfo | undefined;
        if (item.sourcePath) {
          imported = await call<OfficeFileInfo>("office_import_file", { sourcePath: item.sourcePath });
        } else if (item.file) {
          const dataBase64 = await fileToBase64(item.file);
          imported = await call<OfficeFileInfo>("office_import_file", { dataBase64, name: item.name });
        }
        // Fire-and-forget idle-time RAG indexing: runs while the user is still
        // in the composer, so the knowledge search at submit time is instant.
        if (imported?.id) {
          void call<number>("office_index_file", { fileId: imported.id }).catch((e) =>
            console.warn("[office_index_file]", errText(e)),
          );
        }
      }
      if (toPending.length) setPending((prev) => [...prev, ...toPending]);
      await knowledge.refresh();
    } catch (err) {
      console.warn("[office_import_file]", errText(err));
      setImportError(errText(err));
    } finally {
      setImporting(false);
    }
  }, [knowledge.refresh]);

  /** Prompts for a YouTube URL and adds it to the pending (session-only) list. */
  const addKnowledgeLink = useCallback(async () => {
    setImportError(null);
    const url = await platform.promptForUrl("Paste a YouTube video URL");
    if (!url) return;
    if (!isYouTubeUrl(url)) {
      setImportError("Only YouTube URLs are supported for now");
      return;
    }
    const id = youtubeId(url);
    const label = id ? `YouTube · ${id}` : url;
    setPending((prev) => [...prev, { id: nanoid(), kind: "link", name: label, url }]);
  }, []);

  const removePending = useCallback(
    (id: string) => setPending((prev) => prev.filter((p) => p.id !== id)),
    [],
  );

  // Switching agent clears the model context + active session.
  useEffect(() => {
    void chat.selectAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

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
          {AGENTS.map((a) => {
            const Icon = a.icon;
            const active = a.id === activeAgentId;
            return (
              <button
                className={`flex w-full items-center rounded-lg text-left transition-colors ${
                  agentsRail ? "justify-center p-2" : "gap-2.5 px-2.5 py-2"
                } ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                key={a.id}
                onClick={() => setActiveAgentId(a.id)}
                title={`${a.name} · ${a.subtitle}`}
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
                      {a.subtitle}
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
          {!agentsRail && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {chat.userId ?? "demo"}
            </span>
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
                    <agent.icon className="size-6" />
                  </span>
                  <h2 className="text-lg font-semibold text-foreground">{agent.name} agent</h2>
                  <p className="-mt-1 text-sm">{agent.description}</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {agent.prompts.map((prompt) => (
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
                knowledge={knowledge}
                onStop={chat.stop}
                status={status}
                onSubmit={(text, imageB64, knowledgeContext) =>
                  void chat.send(text, imageB64, knowledgeContext)
                }
              />
            </div>
          </section>

          {/* canvas */}
          {canvasOpen && (
            <section className="hidden min-w-0 flex-1 flex-col border-l md:flex">
              <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3">
                <div className="flex items-center gap-4">
                  {(["artifact", "files"] as const).map((tab) => (
                    <button
                      className={`-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors ${
                        canvasTab === tab
                          ? "border-primary text-foreground"
                          : "text-muted-foreground border-transparent"
                      }`}
                      key={tab}
                      onClick={() => setCanvasTab(tab)}
                    >
                      {tab === "artifact" ? "Artifact" : "Files"}
                    </button>
                  ))}
                </div>
                {canvasTab === "files" && (
                  <div className="flex items-center gap-1">
                    <Button
                      onClick={() => void addKnowledgeLink()}
                      size="xs"
                      title="Paste a YouTube video URL"
                      variant="ghost"
                    >
                      <VideoIcon className="size-3" />
                      Link
                    </Button>
                    <Button
                      disabled={importing}
                      onClick={() => void addKnowledgeFiles()}
                      size="xs"
                      title="Import documents & images (.docx .xlsx .pptx .pdf .png .jpg …)"
                      variant="ghost"
                    >
                      {importing ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />}
                      Add files
                    </Button>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {canvasTab === "artifact" ? (
                  <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                    <WrenchIcon className="text-muted-foreground/40 mb-3 size-5" />
                    <p className="text-muted-foreground text-sm">Artifacts will appear here</p>
                    <p className="text-muted-foreground/70 mt-1 text-xs">
                      Generated docs, summaries, and exports
                    </p>
                  </div>
                ) : (
                  <div className="flex h-full flex-col overflow-y-auto">
                    {importError && (
                      <div className="text-destructive border-destructive/40 bg-destructive/10 mx-3 mt-3 rounded-md border px-3 py-2 text-xs">
                        {importError}
                      </div>
                    )}
                    <div className="flex-1 p-3 pt-5">
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
                          Loading files…
                        </div>
                      ) : (
                        <div className="flex flex-col gap-5">
                          <div>
                            <p className="text-muted-foreground px-1 pb-1.5 font-mono text-[11px] tracking-wider uppercase">
                              Documents
                            </p>
                            {knowledge.files.length === 0 ? (
                              <div className="text-muted-foreground/70 px-1 py-2 text-xs">
                                No documents imported yet — they&apos;ll appear here and in the
                                @-mention popup.
                              </div>
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                {knowledge.files.map((file) => (
                                  <div
                                    className="bg-card flex items-center gap-2.5 rounded-lg border px-2.5 py-2"
                                    key={file.id}
                                  >
                                    <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm">{file.originalName}</p>
                                      <p className="text-muted-foreground mt-0.5 text-xs">
                                        {formatBytes(file.bytes)} ·{" "}
                                        {new Date(file.createdAt * 1000).toLocaleDateString()}
                                      </p>
                                    </div>
                                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase">
                                      {file.ext}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="text-muted-foreground flex items-center gap-1.5 px-1 pb-1.5 font-mono text-[11px] tracking-wider uppercase">
                              Images &amp; links
                              <span className="text-muted-foreground/60 font-sans text-[10px] normal-case tracking-normal">
                                session-only · backend coming soon
                              </span>
                            </p>
                            {pending.length === 0 ? (
                              <div className="text-muted-foreground/70 px-1 py-2 text-xs">
                                Use the Link or Add files buttons above to add a YouTube video or an
                                image — not persisted yet.
                              </div>
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                {pending.map((item) => (
                                  <div
                                    className="bg-card flex items-center gap-2.5 rounded-lg border px-2.5 py-2"
                                    key={item.id}
                                  >
                                    {item.kind === "link" ? (
                                      <VideoIcon className="text-muted-foreground size-4 shrink-0" />
                                    ) : (
                                      <ImageIcon className="text-muted-foreground size-4 shrink-0" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm">{item.name}</p>
                                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                                        {item.kind === "link" ? item.url : "Image"}
                                      </p>
                                    </div>
                                    <button
                                      aria-label={`Remove ${item.name}`}
                                      className="text-muted-foreground hover:text-foreground shrink-0"
                                      onClick={() => removePending(item.id)}
                                      title="Remove (session only)"
                                      type="button"
                                    >
                                      <XIcon className="size-3" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
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
                    <button
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                        chat.sessionId === session.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                      key={session.id}
                      onClick={() => void chat.selectSession(session.id)}
                    >
                      {chat.sessionId === session.id && (
                        <span className="bg-primary size-1.5 shrink-0 rounded-full" />
                      )}
                      <span className="truncate">{session.title || `Session #${session.id}`}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
