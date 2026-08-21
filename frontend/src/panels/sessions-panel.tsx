import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RenameInput } from "@/components/rename-input";
import type { ChatSessionInfo } from "@/lib/api";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";

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

  const q = query.trim().toLowerCase();
  const filteredGroups = q
    ? groupedSessions
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter((s) =>
            (s.title ?? "").toLowerCase().includes(q),
          ),
        }))
        .filter((group) => group.sessions.length > 0)
    : groupedSessions;
  const filteredArchived = q
    ? archivedSessions.filter((s) => (s.title ?? "").toLowerCase().includes(q))
    : archivedSessions;

  const startRename = (session: ChatSessionInfo) => {
    setRenamingId(session.id);
    setRenameValue(session.title ?? "");
  };

  const commitRename = () => {
    if (renamingId != null && renameValue.trim()) {
      onRenameSession(renamingId, renameValue);
    }
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
              {group.sessions.map((session) =>
                renamingId === session.id ? (
                  <RenameInput
                    key={session.id}
                    onChange={setRenameValue}
                    onCancel={() => setRenamingId(null)}
                    onCommit={commitRename}
                    value={renameValue}
                  />
                ) : (
                  <div
                    className={`group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                      activeSessionId === session.id
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    }`}
                    key={session.id}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
                      disabled={busy}
                      onClick={() => onSelectSession(session.id)}
                      title={busy ? "Tunggu jawaban selesai" : undefined}
                      type="button"
                    >
                      {activeSessionId === session.id && (
                        <span className="bg-primary size-1.5 shrink-0 rounded-full" />
                      )}
                      <span className="truncate">{session.title || `Session #${session.id}`}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/session:opacity-100">
                      <button
                        aria-label={`Rename ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={busy}
                        onClick={() => startRename(session)}
                        title={busy ? "Tunggu jawaban selesai" : "Rename session"}
                        type="button"
                      >
                        <PencilIcon className="size-3.5" />
                      </button>
                      <button
                        aria-label={`Archive ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={busy}
                        onClick={() => onArchiveSession(session.id, true)}
                        title={busy ? "Tunggu jawaban selesai" : "Archive session"}
                        type="button"
                      >
                        <ArchiveIcon className="size-3.5" />
                      </button>
                      <button
                        aria-label={`Delete ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                        disabled={busy}
                        onClick={() => onDeleteSession(session.id)}
                        title={busy ? "Tunggu jawaban selesai" : "Delete session"}
                        type="button"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ),
              )}
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
                  <div
                    className="group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50"
                    key={session.id}
                  >
                    <button
                      className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
                      disabled={busy}
                      onClick={() => onSelectSession(session.id)}
                      title={busy ? "Tunggu jawaban selesai" : undefined}
                      type="button"
                    >
                      <span className="truncate italic">
                        {session.title || `Session #${session.id}`}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/session:opacity-100">
                      <button
                        aria-label={`Restore ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={busy}
                        onClick={() => onArchiveSession(session.id, false)}
                        title={busy ? "Tunggu jawaban selesai" : "Restore session"}
                        type="button"
                      >
                        <ArchiveRestoreIcon className="size-3.5" />
                      </button>
                      <button
                        aria-label={`Delete ${session.title || `session ${session.id}`}`}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                        disabled={busy}
                        onClick={() => onDeleteSession(session.id)}
                        title={busy ? "Tunggu jawaban selesai" : "Delete session"}
                        type="button"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
