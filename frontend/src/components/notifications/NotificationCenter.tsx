import { BellIcon, CheckCheckIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications } from "@/contexts/NotificationContext";
import { NotificationEmptyState, NotificationItemCard } from "./NotificationItem";

const CATEGORY_TABS = ["all", "agents", "messages", "skills", "system"] as const;

export function NotificationCenter() {
  const { items, unreadCount, markRead, markAllRead, clearAll } = useNotifications();
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
          <BellIcon className="size-4" />
          {unreadCount > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[10px] font-medium">
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
                <CheckCheckIcon className="size-3.5" />
              </Button>
            )}
            {items.length > 0 && (
              <Button aria-label="Clear all" onClick={clearAll} size="icon" variant="ghost" className="size-7">
                <Trash2Icon className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Category filter tabs */}
        <div className="flex gap-1 border-b px-3 py-1.5">
          {CATEGORY_TABS.map((tab) => (
            <button
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
              filtered.map((item) => <NotificationItemCard key={item.id} item={item} onRead={markRead} />)
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
