import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);
const mod = isMac ? "Cmd" : "Ctrl";

/** Live shortcuts only — mirrors useAppShortcuts (App) and the workbench's
 *  Esc/ArrowUp/@ handlers. Update together with those handlers. */
const SHORTCUTS: { action: string; keys: string[] }[] = [
  { action: "Browse sessions", keys: [mod, "K"] },
  { action: "New session / goal", keys: [mod, "N"] },
  { action: "Toggle the assets rail", keys: [mod, "1"] },
  { action: "Close a drawer — or press twice to stop the running plan", keys: ["Esc"] },
  { action: "Recall your last goal (empty composer)", keys: ["↑"] },
  { action: "Attach a knowledge file in the composer", keys: ["@"] },
  { action: "This shortcut list", keys: ["?"] },
];

/** Keyboard shortcut cheat sheet — opened with "?" (outside editable fields
 *  and dialogs). Same visual language as the composer chips: mono labels,
 *  kbd pills. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wider uppercase">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            {mod} means {isMac ? "⌘ Command" : "the Ctrl key"}.
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y">
          {SHORTCUTS.map((s) => (
            <div className="flex items-center justify-between gap-4 py-2" key={s.action}>
              <span className="text-foreground text-sm">{s.action}</span>
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
