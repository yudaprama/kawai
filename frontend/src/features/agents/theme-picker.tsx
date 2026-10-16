import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/hooks/use-i18n";
import {
  removeCustomPalette,
  setPalette,
  type ThemePalette,
  usePaletteId,
  usePalettes,
} from "@/lib/themes";
import { cn } from "@/lib/utils";

/** Preview colors: the palette's own `swatch`, else its light tokens. */
function swatchOf(palette: ThemePalette): string[] {
  if (palette.swatch) return palette.swatch;
  const { light } = palette;
  return [light.background, light.card, light.primary, light.accent, light.foreground].filter(
    (color): color is string => !!color,
  );
}

/**
 * Palette picker — the color half of the appearance settings (the
 * light/dark/system mode lives in the account dropdown next to it). Every
 * palette is a set of shadcn tokens; the catalog is the bundled palettes in
 * `lib/themes.ts` plus any palettes the user previously imported (localStorage).
 */
export function ThemePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const palettes = usePalettes();
  const activeId = usePaletteId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("themePicker.title")}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {palettes.map((palette) => {
            const active = palette.id === activeId;
            return (
              <div key={palette.id} className="relative">
                <button
                  type="button"
                  onClick={() => setPalette(palette.id)}
                  className={cn(
                    "flex w-full flex-col gap-2 rounded-lg border p-2 text-left transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    active ? "border-ring ring-ring/50 ring-2" : "border-border",
                  )}
                >
                  <span className="flex h-8 overflow-hidden rounded-md border">
                    {swatchOf(palette).map((color) => (
                      <span key={color} className="flex-1" style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <span className="truncate">{palette.label}</span>
                    {active && <Icon name="check" className="ml-auto size-4 shrink-0" />}
                  </span>
                </button>
                {palette.custom && (
                  <Button
                    type="button"
                    aria-label={t("themePicker.remove")}
                    title={t("themePicker.remove")}
                    variant="ghost"
                    size="icon"
                    className="absolute -top-1.5 -right-1.5 size-6 rounded-full border bg-background"
                    onClick={() => removeCustomPalette(palette.id)}
                  >
                    <Icon name="x" className="size-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
