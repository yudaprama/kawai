import { AtSignIcon, XIcon } from "lucide-react";
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
import { activeMentionRange } from "@/lib/chat-helpers";
import { logWarn } from "@/lib/logger";

type ChatComposerProps = {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
  lastUserText: string | null;
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  /** Supervisor plan mode: submits route to the planner instead of the agent. */
};

export function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  lastUserText,
  onImageToKnowledge,
}: ChatComposerProps) {
  return (
    <PromptInputProvider>
      <ChatComposerInner
        agentName={agentName}
        onStop={onStop}
        status={status}
        onSubmit={onSubmit}
        lastUserText={lastUserText}
        onImageToKnowledge={onImageToKnowledge}
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
}: ChatComposerProps) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<KnowledgeFileInfo[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFiles, setMentionFiles] = useState<KnowledgeFileInfo[] | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const mentionRange = useRef<{ start: number; end: number } | null>(null);

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
          const next = (value.slice(0, range.start) + value.slice(range.end)).replace(/\s{2,}/g, " ");
          controller.textInput.setInput(next);
        }
        mentionRange.current = null;
      }
      setMentionOpen(false);
      setMentionQuery("");
    },
    [controller],
  );

  const handleTranscription = useCallback(
    (transcript: string) => {
      controller.textInput.setInput(`${controller.textInput.value.trimEnd()} ${transcript}`.trimStart());
    },
    [controller],
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "ArrowUp" && controller.textInput.value === "" && lastUserText) {
        e.preventDefault();
        controller.textInput.setInput(lastUserText);
      }
    },
    [controller, lastUserText],
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      const ids = mentions.map((m) => m.id);
      for (const file of message.files) {
        if (file.mediaType.startsWith("image/") && file.url.startsWith("data:")) {
          const imported = await onImageToKnowledge(file.url, file.fileName ?? "pasted-image");
          ids.push(...imported);
        }
      }
      if (message.text.trim() || ids.length > 0) {
        onSubmit(message.text, ids.length > 0 ? ids : undefined);
      }
      setMentions([]);
    },
    [onImageToKnowledge, onSubmit, mentions],
  );

  const remaining = mentionFiles?.filter((f) => !mentions.some((m) => m.id === f.id)) ?? [];
  const filtered = remaining.filter(
    (f) =>
      mentionQuery === "" ||
      f.originalName.toLowerCase().includes(mentionQuery.toLowerCase()) ||
      f.ext.toLowerCase().includes(mentionQuery.toLowerCase()),
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
                className="hover:bg-background/40 shrink-0 rounded-full p-0.5"
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
          placeholder={`Message ${agentName}…`}
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
                className="size-8 [&_svg]:size-4"
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
                    ? "No more files — import one from the Knowledge panel."
                    : "No files match. Keep typing or import from the Knowledge panel."}
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto">
                  {filtered.map((f) => (
                    <button
                      className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                      key={f.id}
                      onClick={() => pickMention(f)}
                      type="button"
                    >
                      <span className="text-muted-foreground text-[10px] uppercase">{f.ext}</span>
                      <span className="truncate text-xs">{f.originalName}</span>
                    </button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
          <SpeechInput className="size-8 [&_svg]:size-4" onTranscriptionChange={handleTranscription} />
        </PromptInputTools>
        <PromptInputSubmit onStop={onStop} status={status} />
      </PromptInputFooter>
    </PromptInput>
  );
}
