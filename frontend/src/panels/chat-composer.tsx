import { useCallback, useState, type ChangeEvent } from "react";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { call, errText, type KnowledgeFileInfo } from "@/lib/api";
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
import { Button } from "@/components/ui/button";
import type { ChatStatus } from "@/lib/ai-types";
import { AtSignIcon, XIcon } from "lucide-react";

export function ChatComposer({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  return (
    <PromptInputProvider>
      <ChatComposerInner
        agentName={agentName}
        onStop={onStop}
        status={status}
        onSubmit={onSubmit}
        onImageToKnowledge={onImageToKnowledge}
      />
    </PromptInputProvider>
  );
}

function activeMentionQuery(value: string, caret: number): string | null {
  const upTo = value.slice(0, caret);
  const at = upTo.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? " " : upTo[at - 1];
  if (!/\s/.test(before)) return null;
  const query = upTo.slice(at + 1);
  if (/\s/.test(query)) return null;
  return query;
}

function ChatComposerInner({
  agentName,
  status,
  onStop,
  onSubmit,
  onImageToKnowledge,
}: {
  agentName: string;
  status: ChatStatus;
  onStop: () => void;
  onSubmit: (text: string, fileIds?: string[]) => void;
  onImageToKnowledge: (dataUrl: string, name: string) => void;
}) {
  const controller = usePromptInputController();
  const [mentions, setMentions] = useState<KnowledgeFileInfo[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFiles, setMentionFiles] = useState<KnowledgeFileInfo[] | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");

  const loadMentionFiles = useCallback(async () => {
    if (mentionFiles) return;
    try {
      setMentionFiles(await call<KnowledgeFileInfo[]>("knowledge_list"));
    } catch (err) {
      console.warn("[knowledge_list]", errText(err));
      setMentionFiles([]);
    }
  }, [mentionFiles]);

  const toggleMention = useCallback((file: KnowledgeFileInfo) => {
    setMentions((prev) =>
      prev.some((m) => m.id === file.id) ? prev.filter((m) => m.id !== file.id) : [...prev, file],
    );
  }, []);

  const handleComposerChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const caret = e.target.selectionStart ?? value.length;
      const q = activeMentionQuery(value, caret);
      setMentionQuery(q ?? "");
      if (q !== null) {
        setMentionOpen(true);
        void loadMentionFiles();
      } else {
        setMentionOpen(false);
      }
    },
    [loadMentionFiles],
  );

  const pickMention = useCallback(
    (file: KnowledgeFileInfo) => {
      setMentions((prev) => (prev.some((m) => m.id === file.id) ? prev : [...prev, file]));
      const value = controller.textInput.value;
      const token = "@" + mentionQuery;
      const idx = value.lastIndexOf(token);
      if (idx !== -1) {
        const next = (value.slice(0, idx) + value.slice(idx + token.length)).replace(/\s{2,}/g, " ");
        controller.textInput.setInput(next);
      }
      setMentionOpen(false);
      setMentionQuery("");
    },
    [controller, mentionQuery],
  );

  const handleTranscription = useCallback(
    (transcript: string) => {
      controller.textInput.setInput((controller.textInput.value.trimEnd() + " " + transcript).trimStart());
    },
    [controller],
  );

  const handleSubmit = useCallback(
    async (message: { text: string; files: { url: string; mediaType: string; fileName?: string }[] }) => {
      for (const file of message.files) {
        if (file.mediaType.startsWith("image/") && file.url.startsWith("data:")) {
          onImageToKnowledge(file.url, file.fileName ?? "pasted-image");
        }
      }
      const ids = mentions.map((m) => m.id);
      if (message.text.trim() || ids.length > 0) {
        onSubmit(message.text, ids);
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
        <PromptInputTextarea placeholder={`Message ${agentName}…`} onChange={handleComposerChange} />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <Popover
            onOpenChange={(open) => {
              setMentionOpen(open);
              if (open) void loadMentionFiles();
            }}
            open={mentionOpen}
          >
            <PopoverTrigger asChild={true}>
              <Button className="size-8 [&_svg]:size-4" size="icon" title="Mention a file (@)" variant="ghost">
                <AtSignIcon />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              {mentionFiles === null ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">Loading files…</div>
              ) : filtered.length === 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">
                  {remaining.length === 0
                    ? "No more files — import from the Knowledge panel."
                    : "No files match — keep typing or import from the Knowledge panel."}
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
