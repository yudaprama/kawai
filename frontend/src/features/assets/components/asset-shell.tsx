import type { ReactNode } from "react";

/**
 * Shell for the center-pane workspace pages: the page body filling the full
 * height (children own their scrolling — the asset split layout scrolls
 * internally). Page identity comes from the mode bar one row up, and leaving
 * the asset happens through Esc or the avatar dropdown, so no page header
 * restates either. Pages that need a heading of their own render
 * `AssetPageHeader` in their body.
 */
export function AssetShell({ children }: { children: ReactNode }) {
  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col overflow-clip">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">{children}</div>
    </main>
  );
}

/** Shared honest empty state for asset panes awaiting their backend tier. */
export function EmptyPane({ label, description, icon }: { label: string; description: string; icon: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">{icon}</div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="max-w-md text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
