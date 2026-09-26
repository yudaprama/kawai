import { Icon } from "@/components/shared/icon";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications } from "@/contexts/NotificationContext";
import { NotificationEmptyState, NotificationItemCard } from "./NotificationItem";

const CATEGORY_TABS = ["all", "agents", "messages", "skills", "system"] as const;

export function NotificationCenter() {
  const { items, unreadCount, markRead, markAllRead, clearAll, restore } = useNotifications();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<(typeof CATEGORY_TABS)[number]>("all");

  const filtered = filter === "all" ? items : items.filter((i) => i.category === filter);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
          size="icon"
          variant="ghost"
          className="relative"
        >
          <Icon name="bell" className="size-4" />
          {unreadCount > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[11px] font-medium">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button aria-label="Mark all read" onClick={markAllRead} size="icon" variant="ghost" className="size-7">
                <Icon name="check-check" className="size-3.5" />
              </Button>
            )}
            {items.length > 0 && (
              <Button
                aria-label="Clear all"
                onClick={() => {
                  // Optimistic clear + 5s Undo, matching the session-delete
                  // convention; items are in-memory so restore is lossless.
                  const snapshot = items;
                  clearAll();
                  toast(`Cleared ${snapshot.length} notification${snapshot.length === 1 ? "" : "s"}`, {
                    duration: 5000,
                    action: { label: "Undo", onClick: () => restore(snapshot) },
                  });
                }}
                size="icon"
                variant="ghost"
                className="size-7"
              >
                <Icon name="trash-2" className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Category filter tabs */}
        <div className="flex gap-1 border-b px-3 py-1.5">
          {CATEGORY_TABS.map((tab) => (
            <button
              aria-pressed={filter === tab}
              key={tab}
              className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                filter === tab ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setFilter(tab)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Notification list */}
        <ScrollArea className="h-80">
          <div className="flex flex-col gap-1 p-2">
            {filtered.length === 0 ? (
              <NotificationEmptyState />
            ) : (
              filtered.map((item) => (
                <NotificationItemCard
                  key={item.id}
                  item={item}
                  onRead={(id) => {
                    // Tap = mark read AND dismiss; an open popover whose only
                    // effect is a subtle unread-dot change reads as broken.
                    markRead(id);
                    setOpen(false);
                  }}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
