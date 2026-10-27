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

export function SecurityAuditForm({
  disabled,
  onSubmit,
}: {
  disabled?: boolean;
  onSubmit: (target: string, categories: string[] | undefined, intensity: string | undefined) => void;
}) {
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<string[]>(["xss", "sqli"]);
  const [intensity, setIntensity] = useState<string>("minimal");

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
                "rounded-full border px-2.5 py-0.5 font-mono text-[0.625rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
          onChange={(e) => setIntensity(e.target.value)}
          aria-label="Payload intensity"
          className="border-border bg-background text-muted-foreground ml-auto rounded-full border px-2 py-0.5 font-mono text-[0.625rem] outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {INTENSITIES.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        Only scan targets you own or are authorized to test. The plan lands in the review gate — and every active scan
        asks again before it fires.
      </p>
    </div>
  );
}
