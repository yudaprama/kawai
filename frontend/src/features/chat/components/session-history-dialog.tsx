import { useEffect, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import { SessionRow } from "@/features/chat/components/session-row";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useSessionFilter } from "@/hooks/use-session-filter";
import type { ChatSessionInfo } from "@/lib/api";

interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

export function SessionHistoryDialog({
  open,
  onOpenChange,
  groupedSessions,
  archivedSessions,
  activeSessionId,
  busy,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onArchiveSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    if (confirmDeleteId == null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 5000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRenamingId(null);
      setArchiveOpen(false);
      setConfirmDeleteId(null);
    }
  }, [open]);

  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);

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
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Sessions</DialogTitle>
          <DialogDescription className="sr-only">Browse and manage your chat sessions</DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative border-b px-4 py-2">
          <SearchIcon className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-7 size-3.5 -translate-y-1/2" />
          <Input
            className="h-8 pl-8 text-xs"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={query}
          />
          {query && (
            <button
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-7 -translate-y-1/2"
              onClick={() => setQuery("")}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>

        {/* Session list */}
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-3 py-3">
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="text-muted-foreground px-2 pb-1 font-mono text-[11px] tracking-wider uppercase">
                {group.label}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.sessions.map((session) => (
                  <div className="group flex items-center gap-2" key={session.id}>
                    <SessionRow
                      confirmDelete={confirmDeleteId === session.id}
                      session={session}
                      active={activeSessionId === session.id}
                      busy={busy}
                      renaming={renamingId === session.id}
                      renameValue={renameValue}
                      onChangeRename={setRenameValue}
                      onSelect={() => {
                        onSelectSession(session.id);
                        onOpenChange(false);
                      }}
                      onStartRename={() => startRename(session)}
                      onCommitRename={commitRename}
                      onCancelRename={() => setRenamingId(null)}
                      onArchive={() => onArchiveSession(session.id, true)}
                      onDelete={() => requestDelete(session.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {q && filteredGroups.length === 0 && filteredArchived.length === 0 && (
            <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">
              No sessions match "{query.trim()}".
            </p>
          )}

          {filteredGroups.length === 0 && filteredArchived.length === 0 && !q && (
            <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">
              No sessions yet. Start a conversation to create one.
            </p>
          )}

          {filteredArchived.length > 0 && (
            <div>
              <button
                aria-expanded={archiveOpen}
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2 pb-1 text-[11px] font-medium tracking-wider uppercase"
                onClick={() => setArchiveOpen((v) => !v)}
                type="button"
              >
                {archiveOpen ? "▼" : "▶"} Archived ({filteredArchived.length})
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
                      onSelect={() => {
                        onSelectSession(session.id);
                        onOpenChange(false);
                      }}
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
      </DialogContent>
    </Dialog>
  );
}
