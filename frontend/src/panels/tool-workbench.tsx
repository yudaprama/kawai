import { ArrowLeftIcon, ExternalLinkIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { renderToolOutput, toolIcon } from "@/components/ai-elements/tool-renderers";
import { FilePreview } from "@/components/file-preview";
import { ToolOutput } from "@/components/ai-elements/tool";
import type { UIMessage, ToolUIPart } from "@/lib/ai-types";

function extractOfficeFile(value: unknown): { id: string; name: string; bytes?: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const file = (typeof obj.file === "object" && obj.file !== null ? obj.file : obj) as Record<string, unknown>;
  const id = typeof file.id === "string" ? file.id : typeof file.fileId === "string" ? file.fileId : null;
  const name =
    typeof file.originalName === "string"
      ? file.originalName
      : typeof file.filename === "string"
        ? file.filename
        : null;
  if (!id || !name) return null;
  const bytes = typeof file.bytes === "number" ? file.bytes : undefined;
  return { id, name, bytes };
}

export function ToolWorkbench({
  messages,
  toolCallId,
  onBack,
  onOpenPreview,
  onOpenCodeGraph,
}: {
  messages: UIMessage[];
  toolCallId: string;
  onBack: () => void;
  onOpenPreview?: (fileId: string, name: string) => void;
  onOpenCodeGraph?: (query: string, result: string) => void;
}) {
  let selected: ToolUIPart | undefined;
  for (const message of messages) {
    const part = message.parts.find(
      (p): p is ToolUIPart => p.type.startsWith("tool-") && "toolCallId" in p && p.toolCallId === toolCallId,
    );
    if (part) selected = part;
  }
  const name = selected?.type.replace(/^tool-/, "") ?? "tool result";
  const output = selected?.output as { summary?: string; data?: unknown } | undefined;
  const rich = output?.data != null ? renderToolOutput(name, output.data) : null;
  const isOfficeDocument = name === "office_create_document" || name === "office_edit_document";
  const officeFile = isOfficeDocument ? extractOfficeFile(output?.data ?? output?.summary) : null;
  const codegraphResult = name === "codegraph_explore" ? (output?.data ?? output?.summary) : null;
  const codegraphQuery =
    selected?.input &&
    typeof selected.input === "object" &&
    "query" in selected.input &&
    typeof selected.input.query === "string"
      ? selected.input.query
      : "";

  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Button aria-label="Back to chat" onClick={onBack} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        {toolIcon({ toolName: name, className: "size-4" })}
        <h2 className="truncate text-sm font-semibold">{name.replaceAll("_", " ")}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <WrenchIcon className="size-8" />
            Tool result is no longer available.
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {selected.input != null && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">Input</summary>
                <pre className="bg-muted mt-2 overflow-auto rounded-md p-3 text-xs">
                  {JSON.stringify(selected.input, null, 2)}
                </pre>
              </details>
            )}
            {name === "codegraph_explore" && typeof codegraphResult === "string" ? (
              <div className="space-y-3">
                <pre className="bg-muted max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md p-4 text-xs leading-relaxed">
                  {codegraphResult}
                </pre>
                {onOpenCodeGraph && (
                  <button
                    className="text-primary hover:underline text-xs"
                    onClick={() => onOpenCodeGraph(codegraphQuery, codegraphResult)}
                    type="button"
                  >
                    Open in CodeGraph
                  </button>
                )}
              </div>
            ) : officeFile ? (
              <div className="space-y-3">
                <div className="bg-card overflow-hidden rounded-lg border" style={{ height: 480 }}>
                  <FilePreview file={{ id: officeFile.id, name: officeFile.name, size: officeFile.bytes }} />
                </div>
                {onOpenPreview && (
                  <button
                    className="text-primary inline-flex items-center gap-1 hover:underline text-xs"
                    onClick={() => onOpenPreview(officeFile.id, officeFile.name)}
                    type="button"
                  >
                    <ExternalLinkIcon className="size-3" /> Open in preview
                  </button>
                )}
              </div>
            ) : (
              (rich ??
              (output?.summary != null ? (
                <ToolOutput output={output.summary} errorText={selected.errorText} />
              ) : (
                <ToolOutput output={selected.output} errorText={selected.errorText} />
              )))
            )}
          </div>
        )}
      </div>
    </main>
  );
}
