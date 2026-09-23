import { Icon } from "@/components/shared/icon";
import { RenameInput } from "@/components/shared/rename-input";
import { relativeTime } from "@/features/chat/lib/chat-helpers";
import type { ChatSessionInfo } from "@/lib/api";

export function SessionRow({
  session,
  active,
  highlighted,
  busy,
  renaming,
  renameValue,
  onChangeRename,
  onSelect,
  onHighlight,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onArchive,
  onDelete,
  onExport,
  exporting,
  selectMode,
  selected,
  onToggleSelect,
  archivedStyle,
}: {
  session: ChatSessionInfo;
  active?: boolean;
  /** Keyboard-active row in the switcher — same emphasis as hover. */
  highlighted?: boolean;
  busy: boolean;
  renaming: boolean;
  renameValue: string;
  onChangeRename: (v: string) => void;
  onSelect: () => void;
  /** Pointer entered the row — moves the switcher's keyboard cursor here. */
  onHighlight?: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Export the transcript as a stored .md file. */
  onExport?: () => void;
  /** This row's export is in flight — spinner on the export button. */
  exporting?: boolean;
  /** Bulk-select mode: the checkbox replaces the activity dot, row click
   *  toggles selection, and the per-row action cluster hides (the dialog's
   *  bulk bar owns archive/delete). */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  archivedStyle?: boolean;
}) {
  if (renaming) {
    return (
      <RenameInput onChange={onChangeRename} onCancel={onCancelRename} onCommit={onCommitRename} value={renameValue} />
    );
  }
  const label = session.title || `Session #${session.id}`;
  return (
    <div
      className={`group/session flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-[var(--tea-color-bg-brand-lighten-default)] text-foreground"
          : highlighted
            ? "bg-[var(--tea-color-bg-secondary-default)]"
            : "hover:bg-[var(--tea-color-bg-secondary-default)]"
      }`}
    >
      <button
        aria-pressed={selectMode ? selected : undefined}
        className={`flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:opacity-50 ${archivedStyle ? "text-muted-foreground" : ""}`}
        disabled={busy}
        onMouseEnter={onHighlight}
        onClick={selectMode ? onToggleSelect : onSelect}
        type="button"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {selectMode ? (
            /* Checkbox takes the dot's slot so titles stay aligned in both modes. */
            <span
              aria-hidden="true"
              className={`flex size-3.5 shrink-0 items-center justify-center rounded border ${
                selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
              }`}
            >
              {selected && <Icon name="check" className="size-2.5" />}
            </span>
          ) : (
            /* Constant-width dot keeps title alignment stable across rows. */
            <span className={`size-1.5 shrink-0 rounded-full ${active ? "bg-primary" : "bg-transparent"}`} />
          )}
          <span className={`truncate ${archivedStyle ? "italic" : ""}`}>{label}</span>
        </span>
        {/* Meta line: activity time · run tally · last-run status · last goal
            (truncate tail-last so context sheds before facts). */}
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-3.5 font-mono text-[10px] text-muted-foreground/80">
          <span className="shrink-0">{relativeTime(session.updatedAt ?? session.createdAt)}</span>
          {session.runCount > 0 && (
            <>
              <span className="shrink-0 opacity-40">·</span>
              <span className="shrink-0">
                {session.runCount} {session.runCount === 1 ? "run" : "runs"}
              </span>
            </>
          )}
          {session.lastFailed && (
            <span className="text-destructive shrink-0" title="The last run failed">
              failed
            </span>
          )}
          {session.lastGoal && (
            <>
              <span className="shrink-0 opacity-40">·</span>
              <span className="truncate">{session.lastGoal}</span>
            </>
          )}
        </span>
      </button>
      {/* Row actions: hover-revealed on fine-pointer layouts, always visible
          on touch/narrow layouts, and while focused. Hidden in select mode —
          the bulk bar owns archive/delete there. */}
      {!selectMode && (
        <div className="flex shrink-0 items-center gap-1 transition-opacity opacity-70 focus-within:opacity-100 group-hover/session:opacity-100 max-lg:opacity-100">
          {onExport && (
            <button
              aria-label={`Export ${label} as Markdown`}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
              disabled={busy || exporting}
              onClick={onExport}
              title="Export session as Markdown"
              type="button"
            >
              <Icon
                name={exporting ? "loader-circle" : "download"}
                className={`size-3.5 ${exporting ? "animate-spin" : ""}`}
              />
            </button>
          )}
          {!archivedStyle && (
            <button
              aria-label={`Rename ${label}`}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
              disabled={busy}
              onClick={onStartRename}
              type="button"
            >
              <Icon name="pencil" className="size-3.5" />
            </button>
          )}
          <button
            aria-label={`${archivedStyle ? "Restore" : "Archive"} ${label}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
            disabled={busy}
            onClick={onArchive}
            type="button"
          >
            {archivedStyle ? (
              <Icon name="archive-restore" className="size-3.5" />
            ) : (
              <Icon name="archive" className="size-3.5" />
            )}
          </button>
          <button
            aria-label={`Delete ${label}`}
            className="rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
            disabled={busy}
            onClick={onDelete}
            title="Delete session — Undo available for 5 seconds"
            type="button"
          >
            <Icon name="trash" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
