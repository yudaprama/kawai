import { useCallback, useState, type ChangeEvent } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { call, errText, type KnowledgeFileInfo } from "@/lib/api";
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
import { Spinner } from "@/components/ui/spinner";
import { useCopyButton } from "@/hooks/use-copy-button";
import type { ChatStatus, UIMessage } from "@/lib/ai-types";
import type { AgentInfo, ChatSessionInfo } from "@/lib/api";
import {
  AtSignIcon,
  CheckIcon,
  CopyIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  XIcon,
} from "lucide-react";

interface AgentPresentation {
  icon: typeof CheckIcon;
  subtitle: string;
  prompts: string[];
}

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

function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
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

// If the caret sits right after an `@token` (no spaces, `@` at start or
// preceded by whitespace), return that token as the active mention query;
// otherwise null. Drives type-to-mention on the composer.
function activeMentionQuery(value: string, caret: number): string | null {
  const upTo = value.slice(0, caret);
  const at = upTo.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? " " : upTo[at - 1];
  if (!/\s/.test(before)) return null;
  const query = upTo.slice(at + 1);
  if (/\s/.test(query)) return null;
  return query;
}

function ChatComposerInner({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  const controller = usePromptInputController();
  // @-mention attachments: file IDS travel with the message (the backend
  // binds them to the session + prompt) — file CONTENT never enters the
  // composer; the agent still reads it through tools.
  const [mentions, setMentions] = useState<KnowledgeFileInfo[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFiles, setMentionFiles] = useState<KnowledgeFileInfo[] | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");

  const loadMentionFiles = useCallback(async () => {
    if (mentionFiles) return;
    try {
      setMentionFiles(await call<KnowledgeFileInfo[]>("knowledge_list"));
    } catch (err) {
      console.warn("[knowledge_list]", errText(err));
      setMentionFiles([]);
    }
  }, [mentionFiles]);

  const toggleMention = useCallback((file: KnowledgeFileInfo) => {
    setMentions((prev) =>
      prev.some((m) => m.id === file.id)
        ? prev.filter((m) => m.id !== file.id)
        : [...prev, file],
    );
  }, []);

  // Typing `@` (or `@query`) in the composer opens the mention picker and
  // filters it — the same flow the @ button triggers, but keyboard-first.
  const handleComposerChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const caret = e.target.selectionStart ?? value.length;
      const q = activeMentionQuery(value, caret);
      setMentionQuery(q ?? "");
      if (q !== null) {
        setMentionOpen(true);
        void loadMentionFiles();
      } else {
        setMentionOpen(false);
      }
    },
    [loadMentionFiles],
  );

  // Pick a file from the mention picker: add the chip and remove the just
  // typed `@query` from the composer text so it isn't submitted verbatim.
  const pickMention = useCallback(
    (file: KnowledgeFileInfo) => {
      setMentions((prev) =>
        prev.some((m) => m.id === file.id) ? prev : [...prev, file],
      );
      const value = controller.textInput.value;
      const token = "@" + mentionQuery;
      const idx = value.lastIndexOf(token);
      if (idx !== -1) {
        const next = (value.slice(0, idx) + value.slice(idx + token.length)).replace(/\s{2,}/g, " ");
        controller.textInput.setInput(next);
      }
      setMentionOpen(false);
      setMentionQuery("");
    },
    [controller, mentionQuery],
  );

  const handleTranscription = useCallback(
    (transcript: string) => {
      controller.textInput.setInput(
        (controller.textInput.value.trimEnd() + " " + transcript).trimStart(),
      );
    },
    [controller]
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      for (const file of message.files) {
        if (file.mediaType.startsWith("image/") && file.url.startsWith("data:")) {
          onImageToKnowledge(file.url, file.fileName ?? "pasted-image");
        }
      }
      const ids = mentions.map((m) => m.id);
      if (message.text.trim() || ids.length > 0) {
        onSubmit(message.text, ids);
      }
      setMentions([]);
    },
    [onImageToKnowledge, onSubmit, mentions],
  );

  const remaining = mentionFiles?.filter((f) => !mentions.some((m) => m.id === f.id)) ?? [];
  const filtered = remaining.filter(
    (f) =>
      mentionQuery === "" ||
      f.originalName.toLowerCase().includes(mentionQuery.toLowerCase()) ||
      f.ext.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  return (
    <PromptInput
      className="mx-auto max-w-2xl [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:gap-1 [&_[data-slot=input-group]]:overflow-visible [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:px-2 [&_[data-slot=input-group]]:py-1.5"
      onSubmit={handleSubmit}
    >
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-1">
          {mentions.map((m) => (
            <span
              className="bg-accent text-accent-foreground inline-flex max-w-[16rem] items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              key={m.id}
            >
              <span className="truncate">{m.originalName}</span>
              <button
                aria-label={`Remove ${m.originalName}`}
                className="hover:bg-background/40 shrink-0 rounded-full p-0.5"
                onClick={() => toggleMention(m)}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          placeholder={`Message ${agentName}…`}
          onChange={handleComposerChange}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <Popover
            onOpenChange={(open) => {
              setMentionOpen(open);
              if (open) void loadMentionFiles();
            }}
            open={mentionOpen}
          >
            <PopoverTrigger asChild={true}>
              <Button
                className="size-8 [&_svg]:size-4"
                size="icon"
                title="Mention a file (@)"
                variant="ghost"
              >
                <AtSignIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              {mentionFiles === null ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">Loading files…</div>
              ) : filtered.length === 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">
                  {remaining.length === 0
                    ? "No more files — import from the Knowledge panel."
                    : "No files match — keep typing or import from the Knowledge panel."}
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {filtered.map((f) => (
                    <button
                      className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                      key={f.id}
                      onClick={() => pickMention(f)}
                      type="button"
                    >
                      <span className="text-muted-foreground text-[10px] uppercase">{f.ext}</span>
                      <span className="truncate text-xs">{f.originalName}</span>
                    </button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
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

export type { AgentPresentation };

export function ConversationPanel({
  agent,
  presentation,
  messages,
  status,
  sessionId,
  sessions,
  modelLoading,
  modelError,
  modelStatus,
  chatError,
  onStop,
  onSend,
  canvasOpen,
  inSession,
  sessionsCollapsed,
  onToggleCanvas,
  onToggleSessions,
  onImageToKnowledge,
  canvas,
}: {
  agent: AgentInfo;
  presentation: AgentPresentation;
  messages: UIMessage[];
  status: ChatStatus;
  sessionId: number | null;
  sessions: ChatSessionInfo[];
  modelLoading: boolean;
  modelError: boolean;
  modelStatus: string;
  chatError: string | null;
  onStop: () => void;
  onSend: (text: string, fileIds?: string[]) => void;
  canvasOpen: boolean;
  inSession: boolean;
  sessionsCollapsed: boolean;
  onToggleCanvas: () => void;
  onToggleSessions: () => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
  canvas: React.ReactNode;
}) {
  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <span className="truncate text-sm font-medium">
          {inSession
            ? (sessions.find((s) => s.id === sessionId)?.title ?? `${agent.name} agent`)
            : `${agent.name} agent`}
        </span>
        {modelLoading && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Spinner className="size-3" />
            warming up
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={onToggleCanvas}
            size="icon"
            title="Toggle canvas (⌘2)"
            variant={canvasOpen ? "ghost" : "secondary"}
          >
            <PanelRightIcon className="size-4" />
          </Button>
          <Button
            onClick={onToggleSessions}
            size="icon"
            title="Toggle sessions pane (⌘3)"
            variant="ghost"
          >
            {sessionsCollapsed ? <PanelRightOpenIcon className="size-4" /> : <PanelRightCloseIcon className="size-4" />}
          </Button>
        </div>
      </header>

      {modelError && (
        <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 rounded-md border px-3 py-2 text-sm">
          {modelStatus}
        </div>
      )}
      {chatError && (
        <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 rounded-md border px-3 py-2 text-sm">
          {chatError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
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
                      onClick={() => void onSend(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <Conversation className="h-full">
                <ConversationContent className="mx-auto max-w-2xl px-4 pt-6 pb-4">
                  {messages.map((message) => (
                    <MessagePartView key={message.id} message={message} />
                  ))}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className="shrink-0 px-4 pb-4">
            <ChatComposer
              agentName={agent.name}
              onStop={onStop}
              status={status}
              onSubmit={onSend}
              onImageToKnowledge={onImageToKnowledge}
            />
          </div>
        </section>

        {canvas}
      </div>
    </main>
  );
}
