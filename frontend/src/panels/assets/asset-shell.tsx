import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shell for the center-pane asset workspace pages: back-to-chat affordance +
 * page title, then the page body fills the remaining height (children own
 * their scrolling — the asset split layout scrolls internally).
 */
export function AssetShell({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Button aria-label="Back to chat" onClick={onBack} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-muted-foreground truncate text-xs leading-tight">{subtitle}</p>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">{children}</div>
    </main>
  );
}
