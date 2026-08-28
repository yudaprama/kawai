import { ArrowLeftIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { renderToolOutput, toolIcon } from "@/components/ai-elements/tool-renderers";
import { ToolOutput } from "@/components/ai-elements/tool";
import type { UIMessage, ToolUIPart } from "@/lib/ai-types";

export function ToolWorkbench({ messages, toolCallId, onBack }: { messages: UIMessage[]; toolCallId: string; onBack: () => void }) {
  let selected: ToolUIPart | undefined;
  for (const message of messages) {
    const part = message.parts.find((p): p is ToolUIPart => p.type.startsWith("tool-") && "toolCallId" in p && p.toolCallId === toolCallId);
    if (part) selected = part;
  }
  const name = selected?.type.replace(/^tool-/, "") ?? "tool result";
  const output = selected?.output as { summary?: string; data?: unknown } | undefined;
  const rich = output?.data != null ? renderToolOutput(name, output.data) : null;

  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Button aria-label="Back to chat" onClick={onBack} size="icon" variant="ghost"><ArrowLeftIcon className="size-4" /></Button>
        {toolIcon({ toolName: name, className: "size-4" })}
        <h2 className="truncate text-sm font-semibold">{name.replaceAll("_", " ")}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm"><WrenchIcon className="size-8" />Tool result is no longer available.</div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {selected.input != null && <details><summary className="cursor-pointer text-xs font-medium">Input</summary><pre className="bg-muted mt-2 overflow-auto rounded-md p-3 text-xs">{JSON.stringify(selected.input, null, 2)}</pre></details>}
            {rich ?? (output?.summary != null ? <ToolOutput output={output.summary} errorText={selected.errorText} /> : <ToolOutput output={selected.output} errorText={selected.errorText} />)}
          </div>
        )}
      </div>
    </main>
  );
}
