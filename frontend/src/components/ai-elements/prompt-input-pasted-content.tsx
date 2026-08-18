"use client";

import type { FileUIPart } from "@/lib/ai-types";
import type {
  ComponentProps,
  HTMLAttributes,
  PropsWithChildren,
} from "react";

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  createContext,
} from "react";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  XIcon,
} from "lucide-react";
import {
  isPastedTextAttachment,
  PASTED_TEXT_FILENAME,
} from "./prompt-input-helpers";
import type { PastedContentAttachment } from "./prompt-input-helpers";
import { usePromptInputAttachments } from "./prompt-input-context";
import { triggerDownload } from "@/lib/download";

// ============================================================================
// PastedContent context
// ============================================================================

export interface PastedContentContextValue {
  attachment: PastedContentAttachment;
  content: string | null;
  loading: boolean;
  modalOpen: boolean;
  openModal: () => void;
  setModalOpen: (open: boolean) => void;
  copy: () => void;
  download: () => void;
  onRemove: () => void;
}

const PastedContentContext = createContext<PastedContentContextValue | null>(
  null
);

export const usePastedContent = () => {
  const ctx = useContext(PastedContentContext);
  if (!ctx) {
    throw new Error(
      "PastedContent components must be used within <PastedContent>"
    );
  }
  return ctx;
};

export interface PastedContentProps extends PropsWithChildren {
  attachment: PastedContentAttachment;
  onRemove: () => void;
}

export const PastedContent = ({
  attachment,
  onRemove,
  children,
}: PastedContentProps) => {
  const [content, setContent] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!attachment.url) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(attachment.url ?? "");
        const text = await res.text();
        if (!cancelled) {
          setContent(text);
        }
      } catch {
        if (!cancelled) {
          setContent("");
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [attachment.url]);

  const copy = useCallback(async () => {
    if (content !== null) {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        /* clipboard write failed; ignore */
      }
    }
  }, [content]);

  const download = useCallback(() => {
    if (content === null) {
      return;
    }
    triggerDownload(PASTED_TEXT_FILENAME, content, "text/plain");
  }, [content]);

  const openModal = useCallback(() => {
    setModalOpen(true);
  }, []);

  const contextValue = useMemo<PastedContentContextValue>(
    () => ({
      attachment,
      content,
      copy,
      download,
      loading: content === null && Boolean(attachment.url),
      modalOpen,
      onRemove,
      openModal,
      setModalOpen,
    }),
    [attachment, content, modalOpen, openModal, copy, download, onRemove]
  );

  return (
    <PastedContentContext.Provider value={contextValue}>
      {children}
    </PastedContentContext.Provider>
  );
};

// ----------------------------------------------------------------------------
// PastedContentTrigger
// ----------------------------------------------------------------------------

export type PastedContentTriggerProps = HTMLAttributes<HTMLButtonElement> & {
  label?: string;
};

export const PastedContentTrigger = ({
  label = PASTED_TEXT_FILENAME,
  className,
  children,
  ...props
}: PastedContentTriggerProps) => {
  const { openModal } = usePastedContent();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openModal();
      }
    },
    [openModal]
  );

  return (
    <button
      aria-label="View pasted content"
      className={cn("flex items-center gap-1 min-w-0 flex-1", className)}
      onClick={openModal}
      onKeyDown={handleKeyDown}
      type="button"
      {...props}
    >
      {children ?? (
        <>
          <FileTextIcon className="size-3 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
        </>
      )}
    </button>
  );
};

// ----------------------------------------------------------------------------
// PastedContentRemove
// ----------------------------------------------------------------------------

export type PastedContentRemoveProps = ComponentProps<typeof Button>;

export const PastedContentRemove = ({
  className,
  ...props
}: PastedContentRemoveProps) => {
  const { onRemove } = usePastedContent();

  return (
    <Button
      aria-label="Remove pasted content"
      className={cn(
        "size-6 shrink-0 rounded p-0 opacity-70 hover:opacity-100",
        className
      )}
      onClick={onRemove}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      <XIcon className="size-3" />
    </Button>
  );
};

// ----------------------------------------------------------------------------
// PastedContentModal
// ----------------------------------------------------------------------------

export type PastedContentModalProps = Omit<
  ComponentProps<typeof Dialog>,
  "open" | "onOpenChange"
> & {
  contentClassName?: string;
};

export const PastedContentModal = ({
  contentClassName,
  children,
  ...props
}: PastedContentModalProps) => {
  const { modalOpen, setModalOpen } = usePastedContent();

  return (
    <Dialog onOpenChange={setModalOpen} open={modalOpen} {...props}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] flex-col gap-4 sm:max-w-[90vw]",
          contentClassName
        )}
        showCloseButton
      >
        {children}
      </DialogContent>
    </Dialog>
  );
};

// ----------------------------------------------------------------------------
// PastedContentModalHeader
// ----------------------------------------------------------------------------

export type PastedContentModalHeaderProps = HTMLAttributes<HTMLDivElement> & {
  title?: string;
};

export const PastedContentModalHeader = ({
  title = PASTED_TEXT_FILENAME,
  children,
  ...props
}: PastedContentModalHeaderProps) => (
  <DialogHeader {...props}>
    {children ?? <DialogTitle>{title}</DialogTitle>}
  </DialogHeader>
);

// ----------------------------------------------------------------------------
// PastedContentModalBody
// ----------------------------------------------------------------------------

export type PastedContentModalBodyProps = HTMLAttributes<HTMLDivElement>;

export const PastedContentModalBody = ({
  className,
  children,
  ...props
}: PastedContentModalBodyProps) => {
  const { content, loading } = usePastedContent();

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3",
        className
      )}
      {...props}
    >
      {children ??
        (loading ? (
          <pre className="font-mono text-sm">Loading…</pre>
        ) : (
          <div className="flex flex-col font-mono text-sm">
            {(content ?? "").split("\n").map((line, i) => (
              <div className="flex" key={`${line}-${i}`}>
                <span
                  aria-hidden
                  className="shrink-0 select-none pr-3 text-right text-muted-foreground"
                >
                  {i + 1}
                </span>
                <pre className="min-w-max flex-1 whitespace-pre">{line}</pre>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
};

// ----------------------------------------------------------------------------
// PastedContentModalFooter
// ----------------------------------------------------------------------------

export type PastedContentModalFooterProps = HTMLAttributes<HTMLDivElement>;

export const PastedContentModalFooter = ({
  children,
  ...props
}: PastedContentModalFooterProps) => {
  const { content, copy, download } = usePastedContent();
  const disabled = content === null;

  return (
    <DialogFooter {...props}>
      {children ?? (
        <>
          <Button
            disabled={disabled}
            onClick={copy}
            type="button"
            variant="outline"
          >
            <CopyIcon className="size-4" />
          </Button>
          <Button
            disabled={disabled}
            onClick={download}
            type="button"
            variant="outline"
          >
            <DownloadIcon className="size-4" />
          </Button>
        </>
      )}
    </DialogFooter>
  );
};

// ----------------------------------------------------------------------------
// PromptInputPastedContentCard
// ----------------------------------------------------------------------------

export interface PromptInputPastedContentCardProps {
  attachment: FileUIPart & { id: string };
  onRemove: () => void;
}

export const PromptInputPastedContentCard = ({
  attachment,
  onRemove,
}: PromptInputPastedContentCardProps) => (
  <PastedContent attachment={attachment} onRemove={onRemove}>
    <div
      className={cn(
        "group relative flex cursor-pointer select-none items-center gap-1 rounded-md font-medium text-sm transition-all",
        "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        "h-8 border border-border px-1.5"
      )}
    >
      <PastedContentTrigger />
      <PastedContentRemove />
    </div>
    <PastedContentModal>
      <PastedContentModalHeader />
      <PastedContentModalBody />
      <PastedContentModalFooter />
    </PastedContentModal>
  </PastedContent>
);

// ----------------------------------------------------------------------------
// Internal attachment display components
// ----------------------------------------------------------------------------

const PromptInputPastedAttachment = memo(function PromptInputPastedAttachment({
  attachment,
  onRemove,
}: {
  attachment: PastedContentAttachment;
  onRemove: (id: string) => void;
}) {
  const handleRemove = useCallback(
    () => onRemove(attachment.id),
    [onRemove, attachment.id]
  );
  return (
    <PromptInputPastedContentCard
      attachment={attachment}
      onRemove={handleRemove}
    />
  );
});

const PromptInputFileAttachment = memo(function PromptInputFileAttachment({
  data,
  onRemove,
}: {
  data: PastedContentAttachment;
  onRemove: (id: string) => void;
}) {
  const handleRemove = useCallback(
    () => onRemove(data.id),
    [onRemove, data.id]
  );
  return (
    <Attachment data={data} onRemove={handleRemove}>
      <AttachmentPreview />
      <AttachmentRemove />
    </Attachment>
  );
});

export const PromptInputAttachmentsDisplay = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const attachments = usePromptInputAttachments();
  const handleRemove = attachments.remove;

  if (attachments.files.length === 0) {
    return null;
  }

  const pastedFiles = attachments.files.filter(isPastedTextAttachment);
  const otherFiles = attachments.files.filter(
    (f) => !isPastedTextAttachment(f)
  );

  return (
    <Attachments className={cn(className)} variant="inline" {...props}>
      {pastedFiles.map((attachment) => (
        <PromptInputPastedAttachment
          attachment={attachment}
          key={attachment.id}
          onRemove={handleRemove}
        />
      ))}
      {otherFiles.map((attachment) => (
        <PromptInputFileAttachment
          data={attachment}
          key={attachment.id}
          onRemove={handleRemove}
        />
      ))}
    </Attachments>
  );
};
