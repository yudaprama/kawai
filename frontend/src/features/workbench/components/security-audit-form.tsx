import { useState } from "react";

import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";

/** Active categories mirror `lonkero::groups::SCAN_CATEGORIES` (the builder
 *  re-validates server-side — unknown names are a refused plan, never a
 *  silently narrowed run). */
const CATEGORIES: { id: string; label: string }[] = [
  { id: "xss", label: "XSS" },
  { id: "sqli", label: "SQLi" },
  { id: "ssrf", label: "SSRF" },
  { id: "idor", label: "IDOR/BOLA" },
  { id: "auth", label: "Auth" },
  { id: "injection", label: "Injection" },
  { id: "graphql", label: "GraphQL" },
  { id: "api", label: "API" },
  { id: "waf_bypass", label: "WAF bypass" },
  { id: "business_logic", label: "Business logic" },
];

const INTENSITIES = ["minimal", "standard", "extended"] as const;

/** Payload volume per parameter, from lonkero's `PayloadIntensity` — the concrete
 *  numbers are what make the levels meaningful. The time figure is the measured
 *  one from security-tools (recon ≈ 2.5 min, one minimal scan ≈ 2.5 min). */
const INTENSITY_META: Record<(typeof INTENSITIES)[number], { payloads: string; hint: string }> = {
  minimal: { payloads: "50", hint: "50 payloads/parameter — quick validation pass" },
  standard: { payloads: "500", hint: "500 payloads/parameter (10×) — balanced coverage, noticeably slower" },
  extended: { payloads: "5,000", hint: "5,000 payloads/parameter (100×) — deep sweep, slowest" },
};

/** Where the form starts — also where the All chip collapses back to. */
const DEFAULT_SELECTED = ["xss", "sqli"];
const ALL_CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export function SecurityAuditForm({
  disabled,
  onSubmit,
}: {
  disabled?: boolean;
  onSubmit: (target: string, categories: string[] | undefined, intensity: string | undefined) => void;
}) {
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED);
  const [intensity, setIntensity] = useState<(typeof INTENSITIES)[number]>("minimal");
  const allSelected = selected.length === CATEGORIES.length;

  const submit = () => {
    const value = target.trim();
    if (!value || selected.length === 0 || disabled) return;
    // Default-equivalent selection passes undefined so the backend's default
    // stays the single source of truth for the triad.
    const isDefault = selected.length === 3 && ["xss", "sqli", "ssrf"].every((c) => selected.includes(c));
    onSubmit(value, isDefault ? undefined : selected, intensity === "minimal" ? undefined : intensity);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="shield" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Security Audit</span>
        <span className="text-muted-foreground font-mono text-[0.625rem]">recon · gated scans · report</span>
      </div>
      <div className="flex gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="https://your-app.example.com"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-[var(--tea-color-border-focus)] focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !target.trim() || selected.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Audit
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={allSelected}
          onClick={() => setSelected(allSelected ? DEFAULT_SELECTED : ALL_CATEGORY_IDS)}
          className={cn(
            "hit-44 rounded-full border px-3 py-1.5 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            allSelected
              ? "border-primary/60 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          All
        </button>
        {CATEGORIES.map((c) => {
          const active = selected.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() =>
                setSelected((prev) =>
                  prev.includes(c.id) ? prev.filter((existing) => existing !== c.id) : [...prev, c.id],
                )
              }
              className={cn(
                "hit-44 rounded-full border px-3 py-1.5 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          );
        })}
        <select
          value={intensity}
          disabled={disabled}
          onChange={(e) => setIntensity(e.target.value as (typeof INTENSITIES)[number])}
          aria-label="Payload intensity"
          className="border-border bg-background text-muted-foreground hit-44 ml-auto rounded-full border px-2.5 py-1.5 font-mono text-base outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-[0.625rem]"
        >
          {INTENSITIES.map((i) => (
            <option key={i} value={i}>
              {i} · {INTENSITY_META[i].payloads} payloads
            </option>
          ))}
        </select>
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        {INTENSITY_META[intensity].hint}. One category at a time — {selected.length} selected
        {selected.length > 0 && intensity === "minimal"
          ? `, ≈ ${Math.round(selected.length * 2.5 + 2.5)} min total`
          : ""}
        .{selected.includes("waf_bypass") && " WAF bypass always runs at maximum payload volume."}
      </p>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        Only scan targets you own or are authorized to test. The plan lands in the review gate — and every active scan
        asks again before it fires.
      </p>
    </div>
  );
}
