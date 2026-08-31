import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, TrashIcon } from "lucide-react";
import { RenameInput } from "@/components/shared/rename-input";
import type { ChatSessionInfo } from "@/lib/api";

export function SessionRow({
  session,
  active,
  busy,
  renaming,
  renameValue,
  confirmDelete,
  onChangeRename,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onArchive,
  onDelete,
  archivedStyle,
}: {
  session: ChatSessionInfo;
  active?: boolean;
  busy: boolean;
  renaming: boolean;
  renameValue: string;
  /** Delete is armed (first click done) — restyle + hint before the real delete. */
  confirmDelete?: boolean;
  onChangeRename: (v: string) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archivedStyle?: boolean;
}) {
  if (renaming) {
    return (
      <RenameInput onChange={onChangeRename} onCancel={onCancelRename} onCommit={onCommitRename} value={renameValue} />
    );
  }
  return (
    <div
      className={`group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
        confirmDelete
          ? "bg-destructive/10"
          : active
            ? "bg-[var(--tea-color-bg-brand-lighten-default)] text-foreground"
            : "hover:bg-[var(--tea-color-bg-secondary-default)]"
      }`}
    >
      <button
        className={`flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50 ${archivedStyle ? "text-muted-foreground" : ""}`}
        disabled={busy}
        onClick={onSelect}
        type="button"
      >
        {/* Constant-width dot keeps title alignment stable across rows. */}
        <span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-primary" : "bg-transparent"}`} />
        <span className={`truncate ${archivedStyle ? "italic" : ""}`}>{session.title || `Session #${session.id}`}</span>
      </button>
      {/* Row actions: hover-revealed on fine-pointer layouts, always visible
          on touch/narrow layouts, while focused, and while delete is armed —
          the two-click confirmation must never be invisible. */}
      <div
        className={`flex shrink-0 items-center gap-1 transition-opacity ${
          confirmDelete
            ? "opacity-100"
            : "opacity-70 focus-within:opacity-100 group-hover/session:opacity-100 max-lg:opacity-100"
        }`}
      >
        {!archivedStyle && (
          <button
            aria-label={`Rename ${session.title || `session ${session.id}`}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={busy}
            onClick={onStartRename}
            type="button"
          >
            <PencilIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-label={`${archivedStyle ? "Restore" : "Archive"} ${session.title || `session ${session.id}`}`}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={busy}
          onClick={onArchive}
          type="button"
        >
          {archivedStyle ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
        </button>
        <button
          aria-label={`Delete ${session.title || `session ${session.id}`}`}
          className={`rounded p-0.5 disabled:opacity-30 ${
            confirmDelete
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "text-muted-foreground hover:text-destructive"
          }`}
          disabled={busy}
          onClick={onDelete}
          title={confirmDelete ? "Click again to confirm — deletes the session and its messages" : "Delete session"}
          type="button"
        >
          <TrashIcon className="size-3.5" />
          {confirmDelete && <span className="sr-only">Click again to confirm deletion</span>}
        </button>
      </div>
    </div>
  );
}
