import { useCallback, useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCopyButton } from "@/hooks/use-copy-button";
import { useLocalChat } from "@/hooks/use-local-chat";
import type { UIMessage } from "@/lib/ai-types";
import {
  BookOpenIcon,
  BriefcaseIcon,
  CheckIcon,
  CloudSunIcon,
  CopyIcon,
  LineChartIcon,
  PlusIcon,
  WrenchIcon,
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

  const handleSubmit = useCallback(
    (message: { text: string }) => {
      if (message.text.trim()) void chat.send(message.text);
    },
    [chat],
  );

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
              <PromptInput className="mx-auto max-w-2xl" onSubmit={handleSubmit}>
                <PromptInputBody>
                  <PromptInputTextarea placeholder={`Message ${agent.name}…`} />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools />
                  <PromptInputSubmit onStop={chat.stop} status={status} />
                </PromptInputFooter>
              </PromptInput>
            </div>
          </section>

          {/* canvas */}
          {canvasOpen && (
            <section className="hidden min-w-0 flex-1 flex-col border-l md:flex">
              <div className="flex h-10 shrink-0 items-center gap-4 border-b px-3">
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
              <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                {canvasTab === "artifact" ? (
                  <>
                    <WrenchIcon className="text-muted-foreground/40 mb-3 size-5" />
                    <p className="text-muted-foreground text-sm">Artifacts will appear here</p>
                    <p className="text-muted-foreground/70 mt-1 text-xs">
                      Generated docs, summaries, and exports
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground text-sm">No files in this session</p>
                    <p className="text-muted-foreground/70 mt-1 text-xs">Attach files to get started</p>
                  </>
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
