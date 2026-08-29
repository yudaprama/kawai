import type { ReactNode } from "react";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { MetricGrid, parse, str, type Metric } from "./shared";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function renderOfficeDocument(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.file)) return null;
  const file = d.file as Record<string, unknown>;
  const fileId = str(file.id) ?? "";
  const name = str(file.originalName) ?? str(file.filename) ?? "Document";
  if (!fileId) return null;
  const items: Metric[] = [{ label: name, value: "Document created" }];
  return (
    <div className="not-prose space-y-3">
      <MetricGrid items={items} />
      <button className="text-primary hover:underline text-xs" onClick={() => emitOpenPreview(fileId, name)} type="button">
        Open document
      </button>
    </div>
  );
}
