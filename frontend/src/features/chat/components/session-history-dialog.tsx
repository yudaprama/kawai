import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/shared/icon";
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
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRenamingId(null);
      setArchiveOpen(false);
      setActiveIndex(0);
    }
  }, [open]);

  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);

  // Keyboard cursor walks rows in render order: group rows first, then the
  // archived block when it is expanded.
  const visibleRows = useMemo(
    () => [...filteredGroups.flatMap((g) => g.sessions), ...(archiveOpen ? filteredArchived : [])],
    [filteredGroups, filteredArchived, archiveOpen],
  );
  const clampedIndex = Math.min(activeIndex, Math.max(0, visibleRows.length - 1));

  // Follow the cursor with the scroll viewport.
  useEffect(() => {
    listRef.current?.querySelector(`[data-session-index="${clampedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  const selectRow = (index: number) => {
    const target = visibleRows[index];
    if (!target) return;
    onSelectSession(target.id);
    onOpenChange(false);
  };

  // Palette keybindings live on the search input: arrows move the cursor,
  // Enter opens the highlighted row. Rename inputs keep their own Enter.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      if (visibleRows.length === 0) return;
      e.preventDefault();
      setActiveIndex(
        e.key === "ArrowDown"
          ? Math.min(clampedIndex + 1, visibleRows.length - 1)
          : e.key === "ArrowUp"
            ? Math.max(clampedIndex - 1, 0)
            : e.key === "Home"
              ? 0
              : visibleRows.length - 1,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectRow(clampedIndex);
    }
  };

  const startRename = (session: ChatSessionInfo) => {
    setRenamingId(session.id);
    setRenameValue(session.title ?? "");
  };

  const commitRename = () => {
    if (renamingId != null && renameValue.trim()) onRenameSession(renamingId, renameValue);
    setRenamingId(null);
  };

  // Flat render cursor — each row binds its const snapshot (a shared mutable
  // counter would collapse every closure onto the final value).
  let counter = -1;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Sessions</DialogTitle>
          <DialogDescription className="sr-only">
            Browse and manage your chat sessions. Arrow keys move, Enter opens the highlighted row.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative border-b px-4 py-2">
          <Icon
            name="search"
            className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-7 size-3.5 -translate-y-1/2"
          />
          <Input
            className="h-8 pl-8 text-xs"
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
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
              <Icon name="x" className="size-3.5" />
            </button>
          )}
        </div>

        {/* Session list */}
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-3 py-3" ref={listRef}>
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="text-muted-foreground px-2 pb-1 font-mono text-[11px] tracking-wider uppercase">
                {group.label}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.sessions.map((session) => {
                  const idx = ++counter;
                  return (
                    <div className="group flex items-center gap-2" data-session-index={idx} key={session.id}>
                      <SessionRow
                        highlighted={idx === clampedIndex}
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
                        onHighlight={() => setActiveIndex(idx)}
                        onStartRename={() => startRename(session)}
                        onCommitRename={commitRename}
                        onCancelRename={() => setRenamingId(null)}
                        onArchive={() => onArchiveSession(session.id, true)}
                        onDelete={() => onDeleteSession(session.id)}
                      />
                    </div>
                  );
                })}
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
                onClick={() => {
                  setArchiveOpen((v) => !v);
                  setActiveIndex(0);
                }}
                type="button"
              >
                {archiveOpen ? "▼" : "▶"} Archived ({filteredArchived.length})
              </button>
              {archiveOpen && (
                <div className="flex flex-col gap-0.5">
                  {filteredArchived.map((session) => {
                    const idx = ++counter;
                    return (
                      <div className="group flex items-center gap-2" data-session-index={idx} key={session.id}>
                        <SessionRow
                          highlighted={idx === clampedIndex}
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
                          onHighlight={() => setActiveIndex(idx)}
                          onStartRename={() => {}}
                          onCommitRename={commitRename}
                          onCancelRename={() => {}}
                          onArchive={() => onArchiveSession(session.id, false)}
                          onDelete={() => onDeleteSession(session.id)}
                          archivedStyle
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
