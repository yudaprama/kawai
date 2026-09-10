import { AtSignIcon, PlusIcon, VideoIcon, XIcon } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
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
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatStatus } from "@/lib/ai-types";
import { call, type KnowledgeFileInfo } from "@/lib/api";
import { activeMentionRange } from "@/features/chat/lib/chat-helpers";
import { logWarn } from "@/lib/logger";
import { TemplatePicker } from "@/features/chat/components/template-picker";

type ChatComposerProps = {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
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
  /** Supervisor plan mode: submits route to the planner instead of the agent. */
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
  onDraftConsumed,
  placeholder,
}: ChatComposerProps) {
  return (
    <PromptInputProvider>
      <ChatComposerInner
        agentName={agentName}
        chipDraft={chipDraft}
        onDraftConsumed={onDraftConsumed}
        placeholder={placeholder}
        onStop={onStop}
        status={status}
        onSubmit={onSubmit}
        lastUserText={lastUserText}
        onImageToKnowledge={onImageToKnowledge}
        onAddFiles={onAddFiles}
        onAddLink={onAddLink}
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
  onDraftConsumed,
  placeholder,
}: ChatComposerProps) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<KnowledgeFileInfo[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFiles, setMentionFiles] = useState<KnowledgeFileInfo[] | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const mentionRange = useRef<{ start: number; end: number } | null>(null);
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

  // Fresh fetch on every popover open — files imported after mount appear
  // without remounting the composer. Typing keeps the popover open and does
  // NOT re-fetch (filtering happens client-side over the loaded list).
  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    call<KnowledgeFileInfo[]>("knowledge_list")
      .then((rows) => {
        if (!cancelled) setMentionFiles(rows);
      })
      .catch((err) => {
        logWarn("knowledge_list", err);
        if (!cancelled) setMentionFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen]);

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
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
      if (e.key === "ArrowUp" && controller.textInput.value === "" && lastUserText) {
        e.preventDefault();
        controller.textInput.setInput(lastUserText);
      }
    },
    [activeMentionIndex, controller, filtered, lastUserText, mentionOpen, pickMention],
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      if (importProgress) return;
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
        // keeping the draft lets the user retry.
        if (importFailed) return;
        if (message.text.trim() || ids.length > 0) {
          onSubmit(message.text, ids.length > 0 ? ids : undefined);
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
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          data-chat-composer=""
          disabled={importProgress !== null}
          placeholder={
            importProgress
              ? `Importing images… ${importProgress.done}/${importProgress.total}`
              : placeholder ??
                (agentName === "Workbench" ? "Describe your goal…" : `Message ${agentName}…`)
          }
          onChange={handleComposerChange}
          onKeyDown={handleTextareaKeyDown}
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
                <AtSignIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              {mentionFiles === null ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">Loading files…</div>
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
                      aria-selected={filtered.indexOf(f) === activeMentionIndex}
                      className={`hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${
                        filtered.indexOf(f) === activeMentionIndex ? "bg-accent" : ""
                      }`}
                      key={f.id}
                      onClick={() => pickMention(f)}
                      type="button"
                    >
                      <span className="text-muted-foreground text-[11px] uppercase">{f.ext}</span>
                      <span className="truncate text-xs">{f.originalName}</span>
                    </button>
                  ))}
                </div>
              )}
              {(onAddFiles || onAddLink) && (
                <div className="mt-1 flex gap-1 border-t px-1 pt-1">
                  {onAddLink && (
                    <Button
                      disabled={mentionFiles === null}
                      onClick={onAddLink}
                      size="xs"
                      title="Ingest a YouTube video transcript into your knowledge base"
                      variant="ghost"
                    >
                      <VideoIcon className="size-3" />
                      Add link
                    </Button>
                  )}
                  {onAddFiles && (
                    <Button
                      disabled={mentionFiles === null}
                      onClick={onAddFiles}
                      size="xs"
                      title="Import documents & images (.docx .xlsx .pptx .pdf .png .jpg …)"
                      variant="ghost"
                    >
                      <PlusIcon className="size-3" />
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
        <PromptInputSubmit disabled={importProgress !== null} onStop={onStop} status={status} />
      </PromptInputFooter>
    </PromptInput>
  );
}
