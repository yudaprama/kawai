import { PanelRightIcon } from "lucide-react";
import { ToolWorkbench } from "@/features/tools/tool-workbench";
import type { UIMessage } from "@/lib/ai-types";

/**
 * The right-side canvas — shows *output*, never input: tool results (rich
 * renderers, office document previews) from the conversation. Knowledge
 * lives in the composer's attachment (@) menu and the Wiki asset page.
 * Empty state explains what belongs here until the first result is opened.
 */
export function CanvasPanel({
  messages,
  toolCallId,
  onCloseTool,
}: {
  messages: UIMessage[];
  toolCallId: string | null;
  /** Clears the active tool result (canvas stays open on the empty state). */
  onCloseTool: () => void;
}) {
  if (toolCallId == null) {
    return (
      <section className="bg-background flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <PanelRightIcon className="text-muted-foreground/40 size-8" />
        <p className="text-muted-foreground text-sm">Nothing on the canvas yet</p>
        <p className="text-muted-foreground/70 max-w-xs text-xs">
          Click a tool result in the conversation to open it here — rendered documents, slides, charts and outputs
          appear in this pane.
        </p>
      </section>
    );
  }
  return (
    <ToolWorkbench
      messages={messages}
      onBack={onCloseTool}
      toolCallId={toolCallId}
    />
  );
}
