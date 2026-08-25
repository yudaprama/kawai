import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionRow } from "@/components/session-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionFilter } from "@/hooks/use-session-filter";
import type { AgentInfo, ChatSessionInfo } from "@/lib/api";
import { agentPresentation } from "@/panels/agents-rail";

interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

export function SessionsPanel({
  agent,
  railCollapsed,
  groupedSessions,
  archivedSessions,
  activeSessionId,
  busy,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
}: {
  agent: AgentInfo;
  railCollapsed: boolean;
  groupedSessions: SessionGroup[];
  archivedSessions: ChatSessionInfo[];
  activeSessionId: number | null;
  busy: boolean;
  onNewChat: () => void;
  onSelectSession: (id: number) => void;
  onDeleteSession: (id: number) => void;
  onRenameSession: (id: number, title: string) => void;
  onArchiveSession: (id: number, archived: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Two-click delete confirm (same pattern as knowledge files): first click
  // arms the row, second click within the window actually deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);
  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);
  const CapabilityIcon = agentPresentation(agent.id).icon;

  const requestDelete = (sessionId: number) => {
    if (confirmDeleteId === sessionId) {
      setConfirmDeleteId(null);
      onDeleteSession(sessionId);
      return;
    }
    setConfirmDeleteId(sessionId);
  };

  const startRename = (session: ChatSessionInfo) => {
    setRenamingId(session.id);
    setRenameValue(session.title ?? "");
  };
  const commitRename = () => {
    if (renamingId != null && renameValue.trim()) onRenameSession(renamingId, renameValue);
    setRenamingId(null);
  };

  return (
    <aside className="bg-sidebar/40 flex w-[240px] shrink-0 flex-col border-l">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[11px] tracking-wider text-muted-foreground uppercase">Sessions</span>
        <Button disabled={busy} onClick={onNewChat} size="xs" variant="default">
          <PlusIcon className="size-3" />
          New
        </Button>
      </div>
      {railCollapsed && (
        <div className="flex shrink-0 items-center gap-2.5 border-b px-3 py-2" title={agent.description}>
          <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-lg">
            <CapabilityIcon className="size-[15px]" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm leading-tight font-medium">{agent.name}</span>
            <span className="text-muted-foreground truncate text-xs leading-tight">
              {agentPresentation(agent.id).subtitle}
            </span>
          </span>
        </div>
      )}
      <div className="relative shrink-0 border-b px-2 py-1.5">
        <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2" />
        <Input
          className="h-7 pl-8 text-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          value={query}
        />
        {query && (
          <button
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3.5 -translate-y-1/2"
            onClick={() => setQuery("")}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
        {filteredGroups.map((group) => (
          <div key={group.label}>
            <p className="text-muted-foreground px-2.5 pb-1.5 font-mono text-[11px] tracking-wider uppercase">
              {group.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.sessions.map((session) => (
                <SessionRow
                  confirmDelete={confirmDeleteId === session.id}
                  key={session.id}
                  session={session}
                  active={activeSessionId === session.id}
                  busy={busy}
                  renaming={renamingId === session.id}
                  renameValue={renameValue}
                  onChangeRename={setRenameValue}
                  onSelect={() => onSelectSession(session.id)}
                  onStartRename={() => startRename(session)}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                  onArchive={() => onArchiveSession(session.id, true)}
                  onDelete={() => requestDelete(session.id)}
                />
              ))}
            </div>
          </div>
        ))}
        {q && filteredGroups.length === 0 && filteredArchived.length === 0 && (
          <p className="text-muted-foreground/70 px-2.5 py-2 text-xs">No sessions match “{query.trim()}”.</p>
        )}
        {filteredArchived.length > 0 && (
          <div>
            <button
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 pb-1.5 font-mono text-[11px] tracking-wider uppercase"
              onClick={() => setArchiveOpen((v) => !v)}
              type="button"
            >
              {archiveOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              Archived ({filteredArchived.length})
            </button>
            {archiveOpen && (
              <div className="flex flex-col gap-0.5">
                {filteredArchived.map((session) => (
                  <SessionRow
                    confirmDelete={confirmDeleteId === session.id}
                    key={session.id}
                    session={session}
                    busy={busy}
                    renaming={false}
                    renameValue=""
                    onChangeRename={() => {}}
                    onSelect={() => onSelectSession(session.id)}
                    onStartRename={() => {}}
                    onCommitRename={() => {}}
                    onCancelRename={() => {}}
                    onArchive={() => onArchiveSession(session.id, false)}
                    onDelete={() => requestDelete(session.id)}
                    archivedStyle
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
