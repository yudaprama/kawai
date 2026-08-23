import { RenameInput } from "@/components/rename-input";
import type { ChatSessionInfo } from "@/lib/api";
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, TrashIcon } from "lucide-react";

export function SessionRow({
  session,
  active,
  busy,
  renaming,
  renameValue,
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
    return <RenameInput onChange={onChangeRename} onCancel={onCancelRename} onCommit={onCommitRename} value={renameValue} />;
  }
  return (
    <div
      className={`group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
      }`}
    >
      <button
        className={`flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50 ${archivedStyle ? "text-muted-foreground" : ""}`}
        disabled={busy}
        onClick={onSelect}
        type="button"
      >
        {active && <span className="bg-primary size-1.5 shrink-0 rounded-full" />}
        <span className={`truncate ${archivedStyle ? "italic" : ""}`}>{session.title || `Session #${session.id}`}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/session:opacity-100">
        {!archivedStyle && (
          <button
            aria-label={`Rename ${session.title || `session ${session.id}`}`}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={busy}
            onClick={onStartRename}
            type="button"
          >
            <PencilIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-label={`${archivedStyle ? "Restore" : "Archive"} ${session.title || `session ${session.id}`}`}
          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={busy}
          onClick={onArchive}
          type="button"
        >
          {archivedStyle ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
        </button>
        <button
          aria-label={`Delete ${session.title || `session ${session.id}`}`}
          className="text-muted-foreground hover:text-destructive disabled:opacity-30"
          disabled={busy}
          onClick={onDelete}
          type="button"
        >
          <TrashIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
