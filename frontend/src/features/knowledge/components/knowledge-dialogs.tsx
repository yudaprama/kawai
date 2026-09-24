import { useEffect } from "react";
import { FilePreview } from "@/components/shared/file-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { tauriOpenFile, type KnowledgeFileInfo } from "@/lib/api";
import { knowledgeFileToPreview } from "@/lib/preview-file";
import { runningInTauri } from "@/platform";

export function PreviewDialog({ file, onClose }: { file: KnowledgeFileInfo | null; onClose: () => void }) {
  const ext = file?.ext?.toLowerCase();
  // On desktop, PDFs open directly in the OS viewer — skip the modal entirely.
  useEffect(() => {
    if (file && runningInTauri && ext === "pdf") {
      tauriOpenFile(file.id).catch(() => {});
      onClose();
    }
  }, [file, ext, onClose]);

  if (file && runningInTauri && ext === "pdf") return null;

  return (
    <Dialog open={file != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b px-4 py-3">
          <DialogTitle className="truncate text-sm font-medium">{file?.originalName}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col bg-background">
          {file && <FilePreview file={knowledgeFileToPreview(file)} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LinkDialog({
  open,
  onOpenChange,
  linking,
  linkUrl,
  setLinkUrl,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linking: boolean;
  linkUrl: string;
  setLinkUrl: (v: string) => void;
  /** Inline failure from the last submit — stays visible while the dialog is
   *  open so the user can edit the URL and retry. */
  error?: string | null;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The import owns the dialog until it settles — no Esc/overlay dismiss
        // mid-flight (the Cancel button is disabled too).
        if (!next && linking) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a YouTube link</DialogTitle>
          <DialogDescription>
            {linking
              ? "Fetching the transcript — hang tight, this can take a few seconds…"
              : "Paste a YouTube video URL to ingest its transcript into your knowledge base."}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          disabled={linking}
          onChange={(e) => setLinkUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !linking) void onSubmit();
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          type="url"
          value={linkUrl}
        />
        {error && !linking && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={linking} variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button disabled={linking || !linkUrl.trim()} onClick={() => void onSubmit()}>
            {linking ? (
              <>
                <Spinner className="size-3" />
                Importing…
              </>
            ) : (
              "Add"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
