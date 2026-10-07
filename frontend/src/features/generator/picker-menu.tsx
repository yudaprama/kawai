import type { ReactNode } from "react";

import { Icon } from "@/components/shared/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * One entry in a picker dropdown. `retargets` marks an entry the current
 * workflow can't serve: it stays selectable (civitai's `selectorCoherence`
 * retargets the other selector in the same gesture) but is dimmed and carries
 * an arrow, with `title` explaining where it lands.
 */
export interface PickerItem {
  id: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** Leading tile — a model cover, a gradient avatar, or nothing. */
  tile?: ReactNode;
  /** Secondary line under the label (an ecosystem's note, a description). */
  note?: string;
  /** Dimmed + arrow: picking this retargets the other selector. */
  retargets?: boolean;
  /** Tooltip, typically why the entry is dimmed. */
  title?: string;
}

export interface PickerGroup {
  id: string;
  /** Uppercase section label; omit for an ungrouped list. */
  label?: string;
  items: PickerItem[];
}

/**
 * The generator panels' picker dropdown, built on the vendored shadcn
 * DropdownMenu — the three ecosystem pickers and the image workflow picker
 * used to be hand-rolled `role="listbox"` divs with a manual backdrop, which
 * meant no `Escape`, no arrow-key navigation and no focus handling, and they
 * clipped inside the form's scroll container.
 *
 * Radix supplies all of it (open state, keyboard, focus return, portal
 * positioning) so a caller only describes its entries.
 */
export function PickerMenu({
  align = "end",
  ariaLabel,
  contentClassName,
  groups,
  onOpenChange,
  open,
  trigger,
  triggerClassName,
  triggerWidth,
}: {
  align?: "start" | "center" | "end";
  ariaLabel: string;
  contentClassName?: string;
  groups: PickerGroup[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Trigger contents — the caller owns its layout and styling. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Match the content to the trigger's width (the workflow card's full-bleed menu). */
  triggerWidth?: boolean;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger asChild>
        <button aria-label={ariaLabel} className={triggerClassName} type="button">
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn(
          "w-64 rounded-[10px] p-1",
          triggerWidth && "w-(--radix-dropdown-menu-trigger-width)",
          contentClassName,
        )}
        side="bottom"
      >
        {groups.map((group) => (
          <DropdownMenuGroup key={group.id}>
            {group.label && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
            {group.items.map((item) => (
              <DropdownMenuItem
                className={cn("gap-2.5 px-2.5 py-2", item.selected && "bg-accent", item.retargets && "opacity-60")}
                key={item.id}
                onSelect={item.onSelect}
                title={item.title}
              >
                {item.tile}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn("block truncate text-sm font-medium", item.selected && "text-primary font-semibold")}
                  >
                    {item.label}
                  </span>
                  {item.note && <span className="text-muted-foreground block truncate text-[11px]">{item.note}</span>}
                </span>
                {item.selected ? (
                  <Icon className="size-4 shrink-0 text-primary" name="check" />
                ) : item.retargets ? (
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" name="arrow-right" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
