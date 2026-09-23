import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/shared/icon";
import { SessionRow } from "@/features/chat/components/session-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useSessionFilter } from "@/hooks/use-session-filter";
import { groupSessions, type SessionGroup } from "@/features/chat/lib/chat-helpers";
import type { ChatSessionInfo } from "@/lib/api";

export function SessionHistoryDialog({
  open,
  onOpenChange,
  groupedSessions,
  archivedSessions,
  activeSessionId,
  busy,
  onSelectSession,
  onDeleteSessions,
  onRenameSession,
  onArchiveSessions,
  onExportSession,
  onSearchSessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupedSessions: SessionGroup[];
  archivedSessions: ChatSessionInfo[];
  activeSessionId: number | null;
  busy: boolean;
  onSelectSession: (id: number) => void;
  onDeleteSessions: (ids: number[]) => void;
  onRenameSession: (id: number, title: string) => void;
  onArchiveSessions: (ids: number[], archived: boolean) => void;
  /** Export a transcript to a stored .md file; resolves null on failure (the
   *  hook toasted) — the dialog closes only on success. */
  onExportSession: (session: ChatSessionInfo) => Promise<{ id: string; originalName: string; bytes: number } | null>;
  /** Server-side content search (title + message bodies), split active/archived
   *  like `list_chat_sessions`; debounced 250ms, the local title filter stays
   *  the instant layer. */
  onSearchSessions: (q: string) => Promise<{ sessions: ChatSessionInfo[]; archivedSessions: ChatSessionInfo[] }>;
}) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [serverMatches, setServerMatches] = useState<{
    q: string;
    sessions: ChatSessionInfo[];
    archivedSessions: ChatSessionInfo[];
  } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [exportingId, setExportingId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRenamingId(null);
      setArchiveOpen(false);
      setActiveIndex(0);
      setServerMatches(null);
      setSelectMode(false);
      setSelected(new Set());
      setExportingId(null);
    }
  }, [open]);

  const { filteredGroups, filteredArchived, q } = useSessionFilter(groupedSessions, archivedSessions, query);

  // Debounced server-side content search; on error or empty query we fall
  // back to the local title filter. `searchSeq` drops stale responses.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setServerMatches(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      onSearchSessions(trimmed)
        .then((res) => {
          if (seq === searchSeq.current) setServerMatches({ q: trimmed, ...res });
        })
        .catch(() => {
          if (seq === searchSeq.current) setServerMatches(null);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, onSearchSessions]);

  // Server results replace the local layer only while fresh for the CURRENT
  // query (compare raw trimmed strings — case-sensitivity freshness differs
  // from the hook's local lowercase match).
  const { displayGroups, displayArchived } = useMemo(() => {
    if (serverMatches != null && serverMatches.q === query.trim()) {
      return {
        displayGroups: groupSessions(serverMatches.sessions),
        displayArchived: serverMatches.archivedSessions,
      };
    }
    return { displayGroups: filteredGroups, displayArchived: filteredArchived };
  }, [serverMatches, query, filteredGroups, filteredArchived]);

  // Keyboard cursor walks rows in render order: group rows first, then the
  // archived block when it is expanded.
  const visibleRows = useMemo(
    () => [...displayGroups.flatMap((g) => g.sessions), ...(archiveOpen ? displayArchived : [])],
    [displayGroups, displayArchived, archiveOpen],
  );
  const clampedIndex = Math.min(activeIndex, Math.max(0, visibleRows.length - 1));

  // Follow the cursor with the scroll viewport.
  useEffect(() => {
    listRef.current?.querySelector(`[data-session-index="${clampedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectRow = (index: number) => {
    const target = visibleRows[index];
    if (!target) return;
    if (selectMode) {
      toggleSelect(target.id);
      return;
    }
    onSelectSession(target.id);
    onOpenChange(false);
  };

  // Bulk-selection helpers — selection may span active AND archived rows, so
  // Archive/Restore enable per side; Delete covers everything selected.
  const archivedIdSet = useMemo(() => new Set(archivedSessions.map((s) => s.id)), [archivedSessions]);
  const selActive = [...selected].filter((id) => !archivedIdSet.has(id));
  const selArchived = [...selected].filter((id) => archivedIdSet.has(id));
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const allVisibleCount = visibleRows.length;
  const selectAllVisible = () => setSelected(new Set(visibleRows.map((r) => r.id)));
  const bulkArchive = (archived: boolean) => {
    if (selected.size === 0) return;
    onArchiveSessions([...selected], archived);
    exitSelect();
  };
  const bulkDelete = () => {
    if (selected.size === 0) return;
    onDeleteSessions([...selected]);
    exitSelect();
  };

  const doExport = async (session: ChatSessionInfo) => {
    if (exportingId != null) return;
    setExportingId(session.id);
    try {
      const file = await onExportSession(session);
      if (file) onOpenChange(false);
    } finally {
      setExportingId(null);
    }
  };

  // Palette keybindings live on the search input: arrows move the cursor,
  // Enter opens the highlighted row (toggles it in select mode). Rename
  // inputs keep their own Enter.
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
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>Sessions</DialogTitle>
            <Button
              aria-pressed={selectMode}
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              size="xs"
              variant="ghost"
            >
              {selectMode ? "Done" : "Select"}
            </Button>
          </div>
          <DialogDescription className="sr-only">
            Browse and manage your chat sessions. Arrow keys move, Enter opens the highlighted row. Use Select to
            archive or delete several sessions at once.
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
          {displayGroups.map((group) => (
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
                        onArchive={() => onArchiveSessions([session.id], true)}
                        onDelete={() => onDeleteSessions([session.id])}
                        onExport={() => void doExport(session)}
                        exporting={exportingId === session.id}
                        selectMode={selectMode}
                        selected={selected.has(session.id)}
                        onToggleSelect={() => toggleSelect(session.id)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {q && displayGroups.length === 0 && displayArchived.length === 0 && (
            <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">
              No sessions match "{query.trim()}".
            </p>
          )}

          {displayGroups.length === 0 && displayArchived.length === 0 && !q && (
            <p className="text-muted-foreground/70 px-2 py-4 text-center text-xs">
              No sessions yet. Start a conversation to create one.
            </p>
          )}

          {displayArchived.length > 0 && (
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
                {archiveOpen ? "▼" : "▶"} Archived ({displayArchived.length})
              </button>
              {archiveOpen && (
                <div className="flex flex-col gap-0.5">
                  {displayArchived.map((session) => {
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
                          onArchive={() => onArchiveSessions([session.id], false)}
                          onDelete={() => onDeleteSessions([session.id])}
                          onExport={() => void doExport(session)}
                          exporting={exportingId === session.id}
                          selectMode={selectMode}
                          selected={selected.has(session.id)}
                          onToggleSelect={() => toggleSelect(session.id)}
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

        {/* Bulk action bar — only in select mode; selection may span both
            lists, so Archive/Restore enable per side. */}
        {selectMode && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
            <span className="text-muted-foreground text-xs">
              {selected.size} selected
              {selected.size > 0 && selected.size < allVisibleCount && (
                <button
                  className="text-foreground ml-1 underline underline-offset-2"
                  onClick={selectAllVisible}
                  type="button"
                >
                  All {allVisibleCount}
                </button>
              )}
            </span>
            <div className="flex gap-1.5">
              <Button
                disabled={busy || selActive.length === 0}
                onClick={() => bulkArchive(true)}
                size="xs"
                variant="outline"
              >
                Archive
              </Button>
              <Button
                disabled={busy || selArchived.length === 0}
                onClick={() => bulkArchive(false)}
                size="xs"
                variant="outline"
              >
                Restore
              </Button>
              <Button
                className="text-destructive"
                disabled={busy || selected.size === 0}
                onClick={bulkDelete}
                size="xs"
                variant="ghost"
              >
                Delete
              </Button>
              <Button onClick={exitSelect} size="xs" variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
