import { useCallback } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { useCopyButton } from "@/hooks/use-copy-button";
import type { ChatStatus, UIMessage } from "@/lib/ai-types";
import type { AgentInfo, ChatSessionInfo } from "@/lib/api";
import {
  CheckIcon,
  CopyIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
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
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  const controller = usePromptInputController();

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
  onSend: (text: string) => void;
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
