import { useState } from "react";

import { Icon } from "@/components/shared/icon";

export interface YoutubeSummaryFormProps {
  disabled?: boolean;
  onSubmit: (url: string) => void;
}

/** YouTube Summary (PLAN-youtube-summary) entry form on the Workbench
 *  landing. A link in — the FIXED pipeline (transcript parts → compose →
 *  five-section summary) runs through the supervisor scheduler. No planning
 *  round: the pipeline shape is the product. The transcript itself is
 *  fetched server-side; a bad link or a transcript-less video fails as an
 *  ordinary run error. */
export function YoutubeSummaryForm({ disabled, onSubmit }: YoutubeSummaryFormProps) {
  const [url, setUrl] = useState("");

  // Loose host check only — the backend validates the id, the track, and
  // fetches the transcript; this just keeps an obviously-typed sentence out.
  const looksLikeYoutube = /youtube\.com|youtu\.be/i.test(url);
  const submit = () => {
    const link = url.trim();
    if (!link || !looksLikeYoutube || disabled) return;
    onSubmit(link);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="play" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">YouTube Summary</span>
        <span className="text-muted-foreground font-mono text-[10px]">fixed pipeline · no planning round</span>
      </div>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-[var(--tea-color-border-focus)]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !url.trim() || !looksLikeYoutube}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Summarize
        </button>
      </div>
      <p className="text-muted-foreground mt-3 font-mono text-[10px] leading-relaxed">
        TL;DR · key points · timestamps · quotes · action items — in the video&apos;s language.
      </p>
    </div>
  );
}
