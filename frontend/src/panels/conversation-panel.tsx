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
          <Button className="md:hidden" onClick={onOpenMobileAgents} size="icon" title="Agents" variant="ghost">
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
            <Button className="md:hidden" onClick={onOpenMobileSessions} size="icon" title="Sessions" variant="ghost">
              <HistoryIcon className="size-4" />
            </Button>
          )}
          {onOpenMobileKnowledge && (
            <Button
              className="md:hidden"
              onClick={onOpenMobileKnowledge}
              size="icon"
              title="Knowledge"
              variant={canvasOpen ? "ghost" : "secondary"}
            >
              <BookOpenIcon className="size-4" />
            </Button>
          )}
          <Button
            onClick={onToggleThinking}
            size="icon"
            title={thinking ? "Thinking mode: on" : "Thinking mode: off"}
            variant={thinking ? "secondary" : "ghost"}
          >
            <BrainIcon className="size-4" />
          </Button>
          {onToggleCanvas && (
            <Button
              className="hidden md:inline-flex"
              onClick={onToggleCanvas}
              size="icon"
              title="Toggle canvas (⌘2)"
              variant={canvasOpen ? "ghost" : "secondary"}
            >
              <PanelRightIcon className="size-4" />
            </Button>
          )}
          <Button
            className="hidden md:inline-flex"
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
          <span className="min-w-0 flex-1">Gagal memuat riwayat: {historyError}</span>
          <Button onClick={onRetryHistory} size="sm" variant="outline">
            Coba lagi
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className={`flex min-w-0 flex-col ${canvas && canvasOpen ? "md:w-[55%] md:flex-none" : "w-full"}`}>
          <div className="relative min-h-0 flex-1">
            {status === "submitted" && (
              <div className="text-muted-foreground absolute inset-x-0 top-3 z-10 flex justify-center">
                <span className="bg-background/90 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-sm">
                  <Spinner className="size-3" />
                  thinking…
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
                        className="border bg-card hover:bg-accent rounded-full border px-3 py-1 text-xs"
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
                    {(message) => <MessagePartView message={message} />}
                  </ConversationVirtualizedContent>
                ) : (
                  <ConversationContent className="mx-auto max-w-2xl px-4 pt-6 pb-4">
                    {messages.map((message) => (
                      <MessagePartView key={message.id} message={message} />
                    ))}
                  </ConversationContent>
                )}
                <ConversationScrollButton />
              </Conversation>
            )}
          </div>

          <div className="shrink-0 px-4 pb-4">
            {confirmation && (
              <div className="bg-card mb-2 flex items-center gap-3 rounded-lg border p-3">
                <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                  <DatabaseIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Konfirmasi import</p>
                  <p className="text-muted-foreground truncate text-xs" title={confirmation.prompt}>
                    {confirmation.prompt}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button disabled={busy} onClick={() => onSend(confirmation.acceptText)} size="sm">
                    Import
                  </Button>
                  <Button disabled={busy} onClick={() => onSend(confirmation.declineText)} size="sm" variant="ghost">
                    Batal
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

        {canvas && <div className="hidden min-h-0 flex-1 md:flex">{canvas}</div>}
      </div>
    </main>
  );
}
