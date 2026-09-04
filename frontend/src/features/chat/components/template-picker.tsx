import { LayoutTemplateIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { call } from "@/lib/api";
import { logWarn } from "@/lib/logger";

export interface TemplateInfo {
  id: string;
  name: string;
  summary: string;
  bundled: boolean;
}

/**
 * Deck template picker. Lists packs from `office_list_templates` (bundled
 * starters + the cached catalogue — never a network call) and inserts a
 * natural-language selection into the composer, which is how the deck agent
 * learns which `templateId` to use (templateId is a required argument on
 * office_create_deck).
 */
export function TemplatePicker({ onPick }: { onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [query, setQuery] = useState("");

  const load = (open: boolean) => {
    setOpen(open);
    if (open && templates === null) {
      call<TemplateInfo[]>("office_list_templates")
        .then(setTemplates)
        .catch((err) => logWarn("office_list_templates", err));
    }
  };

  const filtered = useMemo(() => {
    if (!templates) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? templates.filter(
          (t) =>
            t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q),
        )
      : templates;
    // Bundled starters first (offline-guaranteed), then catalogue packs.
    return [...list].sort((a, b) => Number(b.bundled) - Number(a.bundled));
  }, [templates, query]);

  const pick = (t: TemplateInfo) => {
    // Structured binding: Rust overrides the model's templateId on the next
    // office_create_deck — the text insertion is for transparency only.
    call<boolean>("office_bind_template", { templateId: t.id }).catch((err) => logWarn("office_bind_template", err));
    onPick(`Use the "${t.id}" template (${t.name}) for the deck.`);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover onOpenChange={load} open={open}>
      <PopoverTrigger asChild={true}>
        <Button
          aria-label="Pick a deck template"
          className="hit-44 size-8 [&_svg]:size-4"
          size="icon"
          title="Deck templates"
          variant="ghost"
        >
          <LayoutTemplateIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="flex items-center gap-2 rounded-sm border px-2 py-1.5">
          <SearchIcon className="text-muted-foreground size-3.5" />
          <input
            aria-label="Search templates"
            className="placeholder:text-muted-foreground w-full bg-transparent text-xs outline-none"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            value={query}
          />
        </div>
        {templates === null ? (
          <div className="text-muted-foreground px-2 py-3 text-xs">Loading templates…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted-foreground px-2 py-3 text-xs">
            {templates.length === 0
              ? "No templates cached yet — the catalogue downloads on first use."
              : "No templates match."}
          </div>
        ) : (
          <div className="mt-1 max-h-64 overflow-y-auto">
            {filtered.map((t) => (
              <button
                className="hover:bg-accent flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left"
                key={t.id}
                onClick={() => pick(t)}
                type="button"
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate text-xs font-medium">{t.name}</span>
                  {t.bundled ? (
                    <span className="text-muted-foreground ml-auto shrink-0 text-[11px] uppercase">built-in</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground line-clamp-2 text-[11px]">{t.summary}</span>
                <span className="text-muted-foreground/70 truncate text-[11px]">{t.id}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
