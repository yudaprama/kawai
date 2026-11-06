import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { errText } from "@/lib/api";
import { cn } from "@/lib/utils";

import { Field } from "./workbench-ui";

/** Coerce an unknown JSON field to a finite number / non-empty string — the
 * guards every engine payload read starts from. */
export const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
export const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** Candle intervals the audit/screener folds accept (mirrors the backend's
 * `AUDIT_INTERVALS`; anything else falls back server-side). */
export const CANDLE_INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;

/** Chip-style toggle button, shared by every preset row on the entry forms. */
export const chip = (active: boolean) =>
  cn(
    "rounded-md border px-2.5 py-1 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    active
      ? "border-primary/60 bg-primary/10 text-primary"
      : "border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground",
  );

/** The "Candles" preset row both entry forms render. */
export function CandlesField({
  disabled,
  interval,
  onInterval,
}: {
  disabled?: boolean;
  interval: string;
  onInterval: (iv: string) => void;
}) {
  return (
    <Field label="Candles">
      {CANDLE_INTERVALS.map((iv) => (
        <button
          key={iv}
          type="button"
          disabled={disabled}
          aria-pressed={interval === iv}
          onClick={() => onInterval(iv)}
          className={chip(interval === iv)}
        >
          {iv}
        </button>
      ))}
    </Field>
  );
}

/** Parse an op's JSON result, keeping only plain objects — anything else
 * (unreadable JSON, arrays, scalars) reads as "nothing usable". */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v == null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** The `{ symbol, error }` rows a placement op rejected. The rejection reason
 * rides `error` (or a caller-supplied fallback — e.g. the grader's first note
 * when it had no level to place); without it the panel could say "1 failed"
 * and nothing more. */
export function failureRows(
  container: Record<string, unknown>,
  key: string,
  errorOf?: (row: Record<string, unknown>) => string,
): { symbol: string; error: string }[] {
  const rows = container[key];
  if (!rows || !Array.isArray(rows)) return [];
  return rows
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f != null)
    .map((f) => ({
      symbol: str(f.symbol) ?? "",
      error: errorOf ? errorOf(f) : typeof f.error === "string" ? f.error : "rejected without a reason",
    }));
}

/** One entry per executed approval, newest last. */
export interface RunLogEntry {
  id: number;
  label: string;
  raw?: string;
  error?: string;
}

/** Shared execution log for the offer panels: guards re-entry via `busy`,
 * appends one entry per run (raw output, or the failure text), and clears
 * `busy` whether the op placed orders or blew up. */
export function useRunLog(): {
  log: RunLogEntry[];
  busy: boolean;
  run: (label: string, execute: () => Promise<string>) => Promise<string | null>;
} {
  const nextId = useRef(0);
  const [log, setLog] = useState<RunLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (label: string, execute: () => Promise<string>): Promise<string | null> => {
    setBusy(true);
    try {
      const raw = await execute();
      const id = ++nextId.current;
      setLog((l) => [...l, { id, label, raw }]);
      return raw;
    } catch (e) {
      const id = ++nextId.current;
      setLog((l) => [...l, { id, label, error: errText(e) }]);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { log, busy, run };
}

/** The approval table shell both offer panels render: a scroll box whose
 * sticky header leads with the select-all checkbox and the Symbol/Side
 * columns; `header` supplies the panel-specific columns after those, and
 * `children` is the `<tbody>` rows. */
export function OfferTable({
  ariaLabel,
  allSelected,
  toggleAll,
  busy,
  header,
  children,
}: {
  ariaLabel: string;
  allSelected: boolean;
  toggleAll: () => void;
  busy: boolean;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-border/60 max-h-96 overflow-y-auto rounded-md border">
      <table className="w-full border-collapse font-mono text-[0.6875rem]">
        <thead className="bg-background sticky top-0 z-10">
          <tr className="text-muted-foreground border-border/60 border-b text-left">
            <th className="p-1.5">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={busy}
                aria-label={ariaLabel}
                className="accent-primary"
              />
            </th>
            <th className="p-1.5">Symbol</th>
            <th className="p-1.5">Side</th>
            {header}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** The "Select all N" shortcut — visible only when something is already
 * selected (deselecting goes through the header checkbox). */
export function SelectAllButton({ visible, onClick, count }: { visible: boolean; onClick: () => void; count: number }) {
  if (!visible) return null;
  return (
    <Button onClick={onClick} size="sm" variant="outline">
      Select all {count}
    </Button>
  );
}

/** The row under the table where the select-all shortcut and the armed
 * approval controls render — same layout in every offer panel. */
export function ArmBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** The Confirm/Cancel pair an armed approval shows. */
export function ArmButtons({
  busy,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Button disabled={busy} onClick={onConfirm} size="sm" variant={destructive ? "destructive" : undefined}>
        Confirm
      </Button>
      <Button disabled={busy} onClick={onCancel} size="sm" variant="outline">
        Cancel
      </Button>
    </>
  );
}
