import { useEffect, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { SessionRow } from "@/features/chat/components/session-row";
import { Input } from "@/components/ui/input";
import { useSessionFilter } from "@/hooks/use-session-filter";
import type { ChatSessionInfo } from "@/lib/api";

interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

/** Persistent sessions rail (xl+). Mirrors SessionHistoryDialog's list
 *  semantics (search, rename, archive, two-click delete) so both entry
 *  points behave identically; the dialog stays the < xl surface. */
export function SessionsRail({
  groupedSessions,
  archivedSessions,
  activeSessionId,
  busy,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
}: {
  groupedSessions: SessionGroup[];
  archivedSessions: ChatSessionInfo[];
  activeSessionId: number | null;
  busy: boolean;
  onSelectSession: (id: number) => void;
  onDeleteSession: (id: number) => void;
  onRenameSession: (id: number, title: string) => void;
  onArchiveSession: (id: number, archived: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 5000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);

  const requestDelete = (sessionId: number) => {
    if (confirmDeleteId === sessionId) {
      setConfirmDeleteId(null);
      onDeleteSession(sessionId);
      return;
    }
    setConfirmDeleteId(sessionId);
  };

  const commitRename = () => {
    if (renamingId != null && renameValue.trim()) onRenameSession(renamingId, renameValue);
    setRenamingId(null);
  };

  return (
    <aside aria-label="Sessions" className="bg-background hidden w-56 shrink-0 flex-col border-l xl:flex">
      <div className="relative border-b px-3 py-2">
        <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2" />
        <Input
          aria-label="Search sessions"
          className="h-7 pl-8 text-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          value={query}
        />
        {query && (
          <button
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-5 -translate-y-1/2"
            onClick={() => setQuery("")}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3">
        {filteredGroups.map((group) => (
          <div key={group.label}>
            <p className="text-muted-foreground px-2 pb-1 font-mono text-[11px] tracking-wider uppercase">
              {group.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.sessions.map((session) => (
                <SessionRow
                  active={activeSessionId === session.id}
                  busy={busy}
                  confirmDelete={confirmDeleteId === session.id}
                  key={session.id}
                  onChangeRename={setRenameValue}
                  onCommitRename={commitRename}
                  onDelete={() => requestDelete(session.id)}
                  onArchive={() => onArchiveSession(session.id, true)}
                  onCancelRename={() => setRenamingId(null)}
                  onSelect={() => onSelectSession(session.id)}
                  onStartRename={() => {
                    setRenamingId(session.id);
                    setRenameValue(session.title ?? "");
                  }}
                  renaming={renamingId === session.id}
                  renameValue={renameValue}
                  session={session}
                />
              ))}
            </div>
          </div>
        ))}

        {q && filteredGroups.length === 0 && filteredArchived.length === 0 && (
          <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">No sessions match "{query.trim()}".</p>
        )}

        {filteredGroups.length === 0 && filteredArchived.length === 0 && !q && (
          <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">
            No sessions yet. Start a conversation to create one.
          </p>
        )}

        {filteredArchived.length > 0 && (
          <div>
            <p className="text-muted-foreground px-2 pb-1 font-mono text-[11px] tracking-wider uppercase">Archived</p>
            <div className="flex flex-col gap-0.5">
              {filteredArchived.map((session) => (
                <SessionRow
                  busy={busy}
                  confirmDelete={confirmDeleteId === session.id}
                  key={session.id}
                  onChangeRename={() => {}}
                  onCommitRename={() => {}}
                  onDelete={() => requestDelete(session.id)}
                  onArchive={() => onArchiveSession(session.id, false)}
                  onCancelRename={() => {}}
                  onSelect={() => onSelectSession(session.id)}
                  onStartRename={() => {}}
                  renaming={false}
                  renameValue=""
                  session={session}
                  archivedStyle
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
