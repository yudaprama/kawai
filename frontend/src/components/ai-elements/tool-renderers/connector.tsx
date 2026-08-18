import type { ReactNode } from "react";
import { parse, isRecord, str, ParamChips } from "./shared";
import { Footnote } from "./shared";
import { WrenchIcon } from "lucide-react";

type ConnTool = {
  name: string;
  description?: string;
  app?: string;
  params?: { required?: string[]; optional?: string[] };
};

/**
 * Terminal-style tool list for connector_list_tools / connector_find_tools —
 * mirrors the Composio playground "related tools" section. Renders only the
 * slim payload that actually reaches the client ({tools:[{name,description,app,
 * params}]}).
 */
export function renderConnectorTools(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.tools)) return null;
  const note = str(d.note);
  const tools = d.tools.filter(isRecord) as ConnTool[];

  if (tools.length === 0) {
    return note ? <Footnote>{note}</Footnote> : <Footnote>No tools.</Footnote>;
  }

  return (
    <div className="not-prose space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground text-[11px] uppercase tracking-wide">
        <WrenchIcon className="size-3" />
        {tools.length} tool{tools.length === 1 ? "" : "s"}
      </div>
      {tools.slice(0, 12).map((t, i) => {
        const req = t.params?.required ?? [];
        const opt = t.params?.optional ?? [];
        return (
          <div
            key={i}
            className="rounded-md border border-border/60 bg-muted/20 px-3 py-2"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-medium text-[13px] text-foreground">
                {str(t.name) ?? "unknown"}
              </span>
              {t.app && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t.app}
                </span>
              )}
            </div>
            {t.description && (
              <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                {t.description}
              </div>
            )}
            {(req.length > 0 || opt.length > 0) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <ParamChips names={req} tone="req" />
                <ParamChips names={opt} tone="opt" />
              </div>
            )}
          </div>
        );
      })}
      {tools.length > 12 && (
        <Footnote>+{tools.length - 12} more</Footnote>
      )}
    </div>
  );
}
