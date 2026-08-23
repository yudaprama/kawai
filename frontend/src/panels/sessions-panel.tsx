import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatSessionInfo } from "@/lib/api";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { SessionRow } from "@/components/session-row";
import { useSessionFilter } from "@/hooks/use-session-filter";

interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

export function SessionsPanel({
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
  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);

  const startRename = (session: ChatSessionInfo) => {
    setRenamingId(session.id);
    setRenameValue(session.title ?? "");
  };
  const commitRename = () => {
    if (renamingId != null && renameValue.trim()) onRenameSession(renamingId, renameValue);
    setRenamingId(null);
  };

  return (
    <aside className="bg-sidebar/40 hidden w-[240px] shrink-0 flex-col border-l md:flex">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
          Sessions
        </span>
        <Button disabled={busy} onClick={onNewChat} size="xs" variant="default">
          <PlusIcon className="size-3" />
          New
        </Button>
      </div>
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
                  onDelete={() => onDeleteSession(session.id)}
                />
              ))}
            </div>
          </div>
        ))}
        {q && filteredGroups.length === 0 && filteredArchived.length === 0 && (
          <p className="text-muted-foreground/70 px-2.5 py-2 text-xs">
            No sessions match “{query.trim()}”.
          </p>
        )}
        {filteredArchived.length > 0 && (
          <div>
            <button
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 pb-1.5 font-mono text-[11px] tracking-wider uppercase"
              onClick={() => setArchiveOpen((v) => !v)}
              type="button"
            >
              {archiveOpen ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
              Archived ({filteredArchived.length})
            </button>
            {archiveOpen && (
              <div className="flex flex-col gap-0.5">
                {filteredArchived.map((session) => (
                  <SessionRow
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
                    onDelete={() => onDeleteSession(session.id)}
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
