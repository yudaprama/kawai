import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotificationItem as NotificationItemType } from "@/contexts/NotificationContext";

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const CATEGORY_COLORS: Record<string, string> = {
  messages: "bg-blue-500/15 text-blue-500",
  agents: "bg-purple-500/15 text-purple-500",
  skills: "bg-emerald-500/15 text-emerald-500",
  system: "bg-amber-500/15 text-amber-500",
};

export function NotificationItemCard({ item, onRead }: { item: NotificationItemType; onRead: (id: string) => void }) {
  return (
    <button
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border p-3 text-left text-sm transition-colors hover:bg-accent/50",
        !item.read && "border-l-2 border-l-primary",
      )}
      onClick={() => {
        if (!item.read) onRead(item.id);
      }}
      type="button"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium",
            CATEGORY_COLORS[item.category] ?? "bg-muted text-muted-foreground",
          )}
        >
          {item.category}
        </span>
        <span className="text-muted-foreground ml-auto text-[11px]">{relativeTime(item.timestamp)}</span>
        {!item.read && <span className="bg-primary size-1.5 shrink-0 rounded-full" />}
      </div>
      <span className="font-medium leading-snug">{item.title}</span>
      {item.body && <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">{item.body}</span>}
    </button>
  );
}

export function NotificationEmptyState() {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm">
      <CheckIcon className="size-5 opacity-40" />
      <span>All caught up</span>
    </div>
  );
}
