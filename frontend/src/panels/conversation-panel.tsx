import {
  BookOpenIcon,
  BrainIcon,
  type CheckIcon,
  DatabaseIcon,
  HistoryIcon,
  MenuIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationVirtualizedContent,
} from "@/components/ai-elements/conversation";
import { MessagePartView } from "@/components/message-part-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ChatStatus, UIMessage } from "@/lib/ai-types";
import type { AgentInfo, ChatSessionInfo } from "@/lib/api";
import type { PendingConfirmation } from "@/hooks/use-local-chat";
import { ChatComposer } from "@/panels/chat-composer";

interface AgentPresentation {
  icon: typeof CheckIcon;
  subtitle: string;
  prompts: string[];
}

export type { AgentPresentation };

const VIRTUALIZE_THRESHOLD = 50;

function estimateMessageSize(msg: UIMessage): number {
  const textLen = msg.parts.find((p) => p.type === "text")?.text.length ?? 0;
  const toolCount = msg.parts.filter((p) => p.type.startsWith("tool-")).length;
  return 80 + Math.ceil(textLen / 80) * 24 + toolCount * 82;
}

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
  thinking,
  onToggleThinking,
  onRetryModel,
  chatError,
  historyError,
  onRetryHistory,
  lastUserText,
  onStop,
  onSend,
  confirmation,
  canvasOpen,
  inSession,
  sessionsCollapsed,
  onToggleCanvas,
  onToggleSessions,
  onImageToKnowledge,
  canvas,
  onboarding,
  onOpenMobileAgents,
  onOpenMobileSessions,
  onOpenMobileKnowledge,
  onOpenTool,
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
  thinking: boolean;
  onToggleThinking: () => void;
  onRetryModel: () => void;
  chatError: string | null;
  historyError: string | null;
  onRetryHistory: () => void;
  lastUserText: string | null;
  onStop: () => void;
  onSend: (text: string, fileIds?: string[]) => void;
  confirmation: PendingConfirmation | null;
  canvasOpen: boolean;
  inSession: boolean;
  sessionsCollapsed: boolean;
  /** Absent when the active agent's registry composition has no context pane —
   *  the toggle and the pane itself stay hidden. */
  onToggleCanvas?: () => void;
  onToggleSessions: () => void;
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  canvas?: React.ReactNode;
  /** Empty-data onboarding (registry-driven, see useContextOnboarding) —
   *  non-null only when the user has no data files/sources yet; replaces the
   *  prompt chips. */
  onboarding: { onImport: () => void; onConnect: () => void } | null;
  onOpenMobileAgents?: () => void;
  onOpenMobileSessions?: () => void;
  onOpenMobileKnowledge?: () => void;
  onOpenTool?: (toolCallId: string) => void;
  onOpenCodeGraph?: (query: string, result: string) => void;
}) {
  const [forceAll, setForceAll] = useState(false);
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (messages.length <= VIRTUALIZE_THRESHOLD || forceAll) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const isSearch = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "f";
      if (isSearch) setForceAll(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [messages.length, forceAll]);
  useEffect(() => {
    if (messages.length <= VIRTUALIZE_THRESHOLD && forceAll) setForceAll(false);
  }, [messages.length, forceAll]);

  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        {onOpenMobileAgents && (
          <Button
            aria-label="Open agents"
            aria-haspopup="dialog"
            className="lg:hidden"
            onClick={onOpenMobileAgents}
            size="icon"
            title="Agents"
            variant="ghost"
          >
            <MenuIcon className="size-4" />
          </Button>
        )}
        <span className="truncate text-sm font-medium">
          {inSession
            ? (sessions.find((s) => s.id === sessionId)?.title ?? `${agent.name} agent`)
            : `${agent.name} agent`}
        </span>
        {modelLoading && (
          <span className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:inline-flex">
            <Spinner className="size-3" />
            {modelStatus || "warming up"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* Mobile: agents/sessions/knowledge drawers */}
          {onOpenMobileSessions && (
            <Button
              aria-haspopup="dialog"
              aria-label="Open sessions"
              className="lg:hidden"
              onClick={onOpenMobileSessions}
              size="icon"
              title="Sessions"
              variant="ghost"
            >
              <HistoryIcon className="size-4" />
            </Button>
          )}
          {onOpenMobileKnowledge && (
            <Button
              aria-haspopup="dialog"
              aria-label="Open knowledge"
              className="lg:hidden"
              onClick={onOpenMobileKnowledge}
              size="icon"
              title="Knowledge"
              variant={canvasOpen ? "ghost" : "secondary"}
            >
              <BookOpenIcon className="size-4" />
            </Button>
          )}
          <Button
            aria-label={thinking ? "Turn thinking mode off" : "Turn thinking mode on"}
            aria-pressed={thinking}
            className="inline-flex"
            onClick={onToggleThinking}
            size="sm"
            title={thinking ? "Thinking mode: on" : "Thinking mode: off"}
            variant={thinking ? "secondary" : "ghost"}
          >
            <BrainIcon className="size-4" />
            <span className="hidden xl:inline">Thinking</span>
          </Button>
          {onToggleCanvas && (
            <Button
              aria-label={canvasOpen ? "Close canvas" : "Open canvas"}
              aria-pressed={canvasOpen}
              className="hidden lg:inline-flex"
              onClick={onToggleCanvas}
              size="sm"
              title={canvasOpen ? "Close canvas (⌘2)" : "Open canvas (⌘2)"}
              variant={canvasOpen ? "ghost" : "secondary"}
            >
              <PanelRightIcon className="size-4" />
              <span className="hidden xl:inline">Canvas</span>
            </Button>
          )}
          <Button
            aria-label={sessionsCollapsed ? "Show sessions" : "Hide sessions"}
            aria-expanded={!sessionsCollapsed}
            className="hidden lg:inline-flex"
            onClick={onToggleSessions}
            size="sm"
            title={sessionsCollapsed ? "Show sessions pane (⌘3)" : "Hide sessions pane (⌘3)"}
            variant="ghost"
          >
            {sessionsCollapsed ? <PanelRightOpenIcon className="size-4" /> : <PanelRightCloseIcon className="size-4" />}
            <span className="hidden xl:inline">Sessions</span>
          </Button>
        </div>
      </header>

      {modelError && (
        <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{modelStatus}</span>
          <Button onClick={onRetryModel} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {chatError && (
        <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 rounded-md border px-3 py-2 text-sm">
          {chatError}
        </div>
      )}
      {historyError && (
        <div className="text-destructive border-destructive/40 bg-destructive/10 mx-4 mt-3 flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">Failed to load history: {historyError}</span>
          <Button onClick={onRetryHistory} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <section
          className={`flex min-w-0 flex-col ${canvas && canvasOpen ? "xl:w-[55%] xl:min-w-[30rem] xl:flex-none" : "w-full"}`}
        >
          <div className="relative min-h-0 flex-1">
            {status === "submitted" && (
              <div className="text-muted-foreground absolute inset-x-0 top-3 z-10 flex justify-center">
                <span className="bg-background/90 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-sm">
                  <Spinner className="size-3" />
                  Thinking…
                </span>
              </div>
            )}
            {!inSession ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="bg-primary/15 text-primary flex size-12 items-center justify-center rounded-xl">
                  <presentation.icon className="size-6" />
                </span>
                <h2 className="text-lg font-semibold text-foreground">{agent.name} agent</h2>
                <p className="-mt-1 text-sm">{agent.description}</p>
                {onboarding ? (
                  <div className="mt-3 w-full max-w-sm rounded-lg border border-dashed p-4 text-left">
                    <p className="text-sm font-medium text-foreground">No data connected yet</p>
                    <p className="mt-1 text-xs">
                      Import a CSV / Excel / parquet file or connect a SQLite / Postgres database, then ask things like
                      &quot;Total sales per category&quot;.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button onClick={onboarding.onImport} size="sm">
                        <UploadIcon className="size-3.5" />
                        Import data file
                      </Button>
                      <Button onClick={onboarding.onConnect} size="sm" variant="outline">
                        <DatabaseIcon className="size-3.5" />
                        Connect database
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {presentation.prompts.map((prompt) => (
                      <button
                        className="border bg-card hover:bg-accent rounded-full px-3 py-1 text-xs"
                        key={prompt}
                        onClick={() => void onSend(prompt)}
                        type="button"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Conversation className="h-full">
                {messages.length > VIRTUALIZE_THRESHOLD &&
                !forceAll &&
                status !== "streaming" &&
                status !== "submitted" ? (
                  <ConversationVirtualizedContent
                    items={messages}
                    estimateSize={estimateMessageSize}
                    getItemKey={(m) => m.id}
                    overscan={8}
                    className="mx-auto max-w-2xl px-4 pt-6 pb-4"
                  >
                    {(message) => <MessagePartView message={message} onOpenTool={onOpenTool} />}
                  </ConversationVirtualizedContent>
                ) : (
                  <ConversationContent className="mx-auto max-w-2xl px-4 pt-6 pb-4">
                    {messages.map((message) => (
                      <MessagePartView key={message.id} message={message} onOpenTool={onOpenTool} />
                    ))}
                  </ConversationContent>
                )}
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className="shrink-0 px-4 pt-2 pb-4">
            {confirmation && (
              <div className="bg-card mb-2 flex items-center gap-3 rounded-lg border p-3">
                <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                  <DatabaseIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Import confirmation</p>
                  <p className="text-muted-foreground truncate text-xs" title={confirmation.prompt}>
                    {confirmation.prompt}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button disabled={busy} onClick={() => onSend(confirmation.acceptText)} size="sm">
                    Import
                  </Button>
                  <Button disabled={busy} onClick={() => onSend(confirmation.declineText)} size="sm" variant="ghost">
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <ChatComposer
              agentName={agent.name}
              onStop={onStop}
              status={status}
              onSubmit={(text, fileIds) => onSend(text, fileIds)}
              lastUserText={lastUserText}
              onImageToKnowledge={onImageToKnowledge}
            />
          </div>
        </section>

        {/* Canvas: an inline third pane from xl; an overlay drawer over the
            conversation at md–lg so the chat never loses its reading width. */}
        {canvas && (
          <div className="bg-background hidden min-h-0 lg:flex lg:absolute lg:inset-y-0 lg:right-0 lg:z-20 lg:w-[min(460px,85%)] lg:shadow-xl xl:static xl:w-auto xl:flex-1 xl:shadow-none">
            {canvas}
          </div>
        )}
      </div>
    </main>
  );
}
