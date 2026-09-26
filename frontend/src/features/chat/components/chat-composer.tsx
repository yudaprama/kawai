import { Icon } from "@/components/shared/icon";
import { FileIcon } from "@/components/shared/file-icon";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { PromptInputAttachmentsDisplay } from "@/components/ai-elements/prompt-input-pasted-content";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatStatus } from "@/lib/ai-types";
import { call, type KnowledgeFileInfo } from "@/lib/api";
import { activeMentionRange } from "@/features/chat/lib/chat-helpers";
import { logWarn } from "@/lib/logger";
import { TemplatePicker } from "@/features/chat/components/template-picker";
import { AttachedFilesChips } from "@/features/knowledge/components/attached-files-chips";
import { useOp } from "@/hooks/use-op";

type ChatComposerProps = {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  /** Submit the draft. A returned/rejected promise matters: PromptInput only
   *  clears the input when this resolves — returning a promise that REJECTS
   *  keeps the draft (blocked submits, failed imports). */
  onSubmit: (text: string, fileIds?: string[]) => void | Promise<void>;
  lastUserText: string | null;
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  /** Knowledge import actions — the composer's attachment menu is the only
   *  in-chat knowledge surface; management lives on the Wiki asset page. */
  onAddFiles?: () => void;
  onAddLink?: () => void;
  /** External draft (e.g. a clicked prompt chip) — dropped into the input
   *  for editing instead of auto-submitting. */
  chipDraft?: { text: string; nonce: number } | null;
  /** Placeholder override (e.g. the workbench contextual follow-up hint). */
  placeholder?: string;
  onDraftConsumed?: () => void;
  /** Disabled state — true when generation is in progress. */
  disabled?: boolean;
  /** Supervisor plan mode: submits route to the planner instead of the agent. */
  attachedFiles?: KnowledgeFileInfo[];
  onRemoveAttachedFile?: (file: KnowledgeFileInfo) => void;
};

export function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  lastUserText,
  onImageToKnowledge,
  onAddFiles,
  onAddLink,
  chipDraft,
  attachedFiles,
  onRemoveAttachedFile,
  onDraftConsumed,
  placeholder,
  disabled,
}: ChatComposerProps) {
  return (
    <PromptInputProvider>
      <ChatComposerInner
        agentName={agentName}
        chipDraft={chipDraft}
        disabled={disabled}
        onDraftConsumed={onDraftConsumed}
        placeholder={placeholder}
        onStop={onStop}
        status={status}
        onSubmit={onSubmit}
        lastUserText={lastUserText}
        onImageToKnowledge={onImageToKnowledge}
        onAddFiles={onAddFiles}
        onAddLink={onAddLink}
        attachedFiles={attachedFiles}
        onRemoveAttachedFile={onRemoveAttachedFile}
      />
    </PromptInputProvider>
  );
}

function ChatComposerInner({
  agentName,
  status,
  onStop,
  onSubmit,
  lastUserText,
  onImageToKnowledge,
  onAddFiles,
  onAddLink,
  chipDraft,
  attachedFiles,
  onRemoveAttachedFile,
  onDraftConsumed,
  placeholder,
  disabled,
}: ChatComposerProps) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<KnowledgeFileInfo[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const mentionRange = useRef<{ start: number; end: number } | null>(null);
  const [recallFlash, setRecallFlash] = useState(false);
  const consumedNonce = useRef<number | null>(null);

  // Drop an external draft (prompt chip) into the input for editing.
  useEffect(() => {
    if (!chipDraft || consumedNonce.current === chipDraft.nonce) return;
    consumedNonce.current = chipDraft.nonce;
    controller.textInput.setInput(
      controller.textInput.value.trim() ? `${controller.textInput.value.trimEnd()} ${chipDraft.text}` : chipDraft.text,
    );
    onDraftConsumed?.();
  }, [chipDraft, controller, onDraftConsumed]);

  const mentionOp = useOp<KnowledgeFileInfo[]>("knowledge_list", undefined, { enabled: false, onError: "log" });
  const mentionFiles = mentionOp.data ?? null;

  // Fresh fetch on every popover open — files imported after mount appear
  // without remounting the composer, and a failed fetch retries on the next
  // open. Typing keeps the popover open and does NOT re-fetch (filtering
  // happens client-side over the loaded list).
  useEffect(() => {
    if (mentionOpen) void mentionOp.execute();
  }, [mentionOpen, mentionOp.execute]);

  const toggleMention = useCallback((file: KnowledgeFileInfo) => {
    setMentions((prev) =>
      prev.some((m) => m.id === file.id) ? prev.filter((m) => m.id !== file.id) : [...prev, file],
    );
  }, []);

  const handleComposerChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    const m = activeMentionRange(value, caret);
    setMentionQuery(m?.query ?? "");
    mentionRange.current = m ? { start: m.start, end: m.end } : null;
    setActiveMentionIndex(0);
    setMentionOpen(m !== null);
  }, []);

  const pickMention = useCallback(
    (file: KnowledgeFileInfo) => {
      setMentions((prev) => (prev.some((m) => m.id === file.id) ? prev : [...prev, file]));
      const range = mentionRange.current;
      if (range) {
        // Remove exactly the "@query" span captured at last keystroke — never
        // an earlier "@" occurrence elsewhere in the text.
        const value = controller.textInput.value;
        if (range.end <= value.length && value[range.start] === "@") {
          // Remove only the mention and one adjacent separator. Never normalize
          // whitespace in the rest of the user's draft (newlines/indentation matter).
          const after = value.slice(range.end);
          const separator = after.match(/^\s/) ? after.slice(0, 1) : "";
          controller.textInput.setInput(value.slice(0, range.start) + after.slice(separator.length));
        }
        mentionRange.current = null;
      }
      setMentionOpen(false);
      setMentionQuery("");
      setActiveMentionIndex(0);
    },
    [controller],
  );

  const remaining = mentionFiles?.filter((f) => !mentions.some((m) => m.id === f.id)) ?? [];
  const filtered = remaining.filter(
    (f) =>
      mentionQuery === "" ||
      f.originalName.toLowerCase().includes(mentionQuery.toLowerCase()) ||
      f.ext.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  const handleTranscription = useCallback(
    (transcript: string) => {
      controller.textInput.setInput(`${controller.textInput.value.trimEnd()} ${transcript}`.trimStart());
    },
    [controller],
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOpen && filtered.length > 0) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setActiveMentionIndex((i) =>
            e.key === "ArrowDown" ? (i + 1) % filtered.length : (i - 1 + filtered.length) % filtered.length,
          );
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          pickMention(filtered[activeMentionIndex]);
          return;
        }
      }
      if (mentionOpen && e.key === "Escape") {
        // stopPropagation: the window-level Esc handler stops a running plan,
        // and with the composer now editable mid-run this Esc must mean
        // "close the file popover", never "kill the run".
        e.stopPropagation();
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
      if (e.key === "ArrowUp" && controller.textInput.value === "" && lastUserText) {
        e.preventDefault();
        controller.textInput.setInput(lastUserText);
        setRecallFlash(true);
        toast("Last goal recalled", { duration: 1500 });
        setTimeout(() => setRecallFlash(false), 1500);
        return;
      }
    },
    [activeMentionIndex, controller, filtered, lastUserText, mentionOpen, pickMention],
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      // Re-entry guard: an import or a previous submit is still in flight.
      // REJECT so the draft stays (a resolve would clear it while the first
      // attempt is still running).
      if (importProgress) throw new Error("Submit already in progress");
      const imageFiles = message.files.filter(
        (file) => file.mediaType.startsWith("image/") && file.url.startsWith("data:"),
      );
      setImportProgress(imageFiles.length > 0 ? { done: 0, total: imageFiles.length } : null);
      try {
        // Revalidate mentions against the current library so deleted files are not
        // sent as stale IDs. Imports run concurrently for responsive multi-paste.
        const currentFiles = await call<KnowledgeFileInfo[]>("knowledge_list").catch(() => []);
        const ids = mentions.filter((m) => currentFiles.some((f) => f.id === m.id)).map((m) => m.id);
        let completed = 0;
        const imports = await Promise.allSettled(
          imageFiles.map(async (file) => {
            try {
              return await onImageToKnowledge(file.url, file.fileName ?? "pasted-image");
            } finally {
              completed += 1;
              setImportProgress({ done: completed, total: imageFiles.length });
            }
          }),
        );
        let importFailed = false;
        for (const result of imports) {
          if (result.status === "fulfilled") ids.push(...result.value);
          else {
            importFailed = true;
            logWarn("image_to_knowledge", result.reason);
          }
        }
        // Do not silently submit a message after an attachment import failed;
        // REJECT so PromptInput keeps the draft and the user can retry.
        if (importFailed) throw new Error("Attachment import failed");
        if (message.text.trim() || ids.length > 0) {
          // Awaited: PromptInput clears the input only once this settles —
          // a rejected run gate (no tokens, session create failed…) lands as
          // a kept draft instead of a silent wipe.
          await onSubmit(message.text, ids.length > 0 ? ids : undefined);
        }
        setMentions([]);
      } finally {
        setImportProgress(null);
      }
    },
    [importProgress, mentions, onImageToKnowledge, onSubmit],
  );

  return (
    <PromptInput
      className="mx-auto max-w-2xl [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:items-stretch [&_[data-slot=input-group]]:gap-1 [&_[data-slot=input-group]]:overflow-visible [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:px-2 [&_[data-slot=input-group]]:py-1.5"
      onSubmit={handleSubmit}
    >
      {attachedFiles && <AttachedFilesChips files={attachedFiles} onRemove={onRemoveAttachedFile} />}
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-1">
          {mentions.map((m) => (
            <span
              className="bg-accent text-accent-foreground inline-flex max-w-[16rem] items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              key={m.id}
            >
              <span className="truncate">{m.originalName}</span>
              <button
                aria-label={`Remove ${m.originalName}`}
                className="hover:bg-background/40 hit-44 flex size-8 shrink-0 items-center justify-center rounded-full"
                onClick={() => toggleMention(m)}
                type="button"
              >
                <Icon name="x" className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <PromptInputBody>
        <PromptInputAttachmentsDisplay className="px-2 pt-1" />
        <PromptInputTextarea
          data-chat-composer=""
          disabled={disabled || importProgress !== null}
          placeholder={
            importProgress
              ? `Importing images… ${importProgress.done}/${importProgress.total}`
              : (placeholder ??
                (agentName === "Workbench" ? "What would you like Kawai to do?" : `Message ${agentName}…`))
          }
          onChange={handleComposerChange}
          onKeyDown={handleTextareaKeyDown}
          className={recallFlash ? "ring-2 ring-primary/50 rounded transition-all duration-300" : undefined}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <Popover onOpenChange={setMentionOpen} open={mentionOpen}>
            <PopoverTrigger asChild={true}>
              <Button
                aria-label="Mention a file"
                className="hit-44 size-8 [&_svg]:size-4"
                size="icon"
                title="Mention a file (@)"
                variant="ghost"
              >
                <Icon name="at-sign" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              {mentionFiles === null ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">
                  {mentionOp.loading
                    ? "Loading files…"
                    : `Couldn't load files — ${mentionOp.error ?? "unknown error"}. Reopen to retry.`}
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">
                  {remaining.length === 0
                    ? "No more files — import one below."
                    : "No files match. Keep typing or import below."}
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {filtered.map((f) => (
                    <button
                      className={`hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${
                        filtered.indexOf(f) === activeMentionIndex ? "bg-accent" : ""
                      }`}
                      key={f.id}
                      onClick={() => pickMention(f)}
                      type="button"
                    >
                      <FileIcon name={f.originalName} />
                      <span className="truncate text-xs">{f.originalName}</span>
                    </button>
                  ))}
                </div>
              )}
              {(onAddFiles || onAddLink) && (
                <div className="mt-1 flex gap-1 border-t px-1 pt-1">
                  {onAddLink && (
                    <Button
                      onClick={onAddLink}
                      size="xs"
                      title="Ingest a YouTube video transcript into your knowledge base"
                      variant="ghost"
                    >
                      <Icon name="video" className="size-3" />
                      Add link
                    </Button>
                  )}
                  {onAddFiles && (
                    <Button
                      onClick={onAddFiles}
                      size="xs"
                      title="Import documents & images (.docx .xlsx .pptx .pdf .png .jpg …)"
                      variant="ghost"
                    >
                      <Icon name="plus" className="size-3" />
                      Add files
                    </Button>
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>
          <TemplatePicker
            onPick={(text) => {
              const cur = controller.textInput.value;
              controller.textInput.setInput(cur.trim() ? `${cur.trimEnd()} ${text}` : text);
            }}
          />
          <SpeechInput className="hit-44 size-8 [&_svg]:size-4" onTranscriptionChange={handleTranscription} />
        </PromptInputTools>
        <PromptInputSubmit disabled={disabled || importProgress !== null} onStop={onStop} status={status} />
      </PromptInputFooter>
    </PromptInput>
  );
}
