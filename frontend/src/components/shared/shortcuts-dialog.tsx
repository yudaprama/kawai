import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/hooks/use-i18n";
import type { TranslationKey } from "@/lib/i18n";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);
const mod = isMac ? "Cmd" : "Ctrl";

/** Live shortcuts only — mirrors useAppShortcuts (App) and the workbench's
 *  Esc/ArrowUp/@ handlers. Update together with those handlers. */
const SHORTCUTS: { action: TranslationKey; keys: string[]; note?: TranslationKey }[] = [
  { action: "keyboardShortcuts.actions.browseSessions", keys: [mod, "K"] },
  { action: "keyboardShortcuts.actions.newSession", keys: [mod, "N"] },
  { action: "keyboardShortcuts.actions.closeDrawer", keys: ["Esc"] },
  {
    action: "keyboardShortcuts.actions.leaveAssetView",
    keys: ["Esc"],
    note: "keyboardShortcuts.actions.unavailableNote",
  },
  { action: "keyboardShortcuts.actions.recallGoal", keys: ["↑"] },
  { action: "keyboardShortcuts.actions.attachFile", keys: ["@"] },
  { action: "keyboardShortcuts.actions.thisList", keys: ["?"] },
];

/** Keyboard shortcut cheat sheet — opened with "?" (outside editable fields
 *  and dialogs). Same visual language as the composer chips: mono labels,
 *  kbd pills. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wider uppercase">
            {t("keyboardShortcuts.title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            {t("keyboardShortcuts.description", { mod })}
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y">
          {SHORTCUTS.map((s) => (
            <div className="flex items-center justify-between gap-4 py-2" key={s.action}>
              <div className="flex-1 min-w-0">
                <span className="text-foreground text-sm">{t(s.action)}</span>
                {s.note && <span className="block text-muted-foreground text-[10px] mt-0.5">{t(s.note)}</span>}
              </div>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd
                    className="bg-accent text-accent-foreground rounded border px-1.5 py-0.5 font-mono text-[10px]"
                    key={k}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
