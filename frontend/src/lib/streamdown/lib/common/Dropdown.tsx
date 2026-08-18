import { useContext, useRef, useState } from "react";
import { StreamdownContext } from "../../index";
import { useClickOutside } from "../click-outside";
import { useCn } from "../prefix-context";
import { ACTION_BUTTON_CLASSES } from "../utils";

export interface DropdownItem {
  label: string;
  onClick: () => void;
  title?: string;
  className?: string;
}

export interface DropdownProps {
  children?: React.ReactNode;
  className?: string;
  items: DropdownItem[];
  triggerTitle?: string;
  triggerAriaLabel?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "left" | "right";
  zIndex?: number;
}

export const Dropdown = ({
  children,
  className,
  items,
  triggerTitle,
  triggerAriaLabel,
  disabled = false,
  onOpenChange,
  align = "right",
  zIndex = 10,
}: DropdownProps) => {
  const cn = useCn();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { isAnimating } = useContext(StreamdownContext);

  const handleToggle = () => {
    const newOpen = !isOpen;
    setIsOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  useClickOutside(dropdownRef, () => setIsOpen(false));

  return (
    <div className={cn("relative")} ref={dropdownRef}>
      <button
        className={cn(ACTION_BUTTON_CLASSES, className)}
        disabled={disabled || isAnimating}
        onClick={handleToggle}
        title={triggerTitle}
        aria-label={triggerAriaLabel}
        type="button"
      >
        {children}
      </button>
      {isOpen ? (
        <div
          className={cn(
            "absolute top-full z-20 mt-1 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg",
            align === "left" ? "left-0" : "right-0"
          )}
          style={{ zIndex }}
        >
          {items.map((item, index) => (
            <button
              key={index}
              className={cn(
                "w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40",
                item.className
              )}
              onClick={() => {
                item.onClick();
                setIsOpen(false);
              }}
              title={item.title}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};