import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";

/**
 * Reusable filter bar for asset list pages: a search input + count display +
 * optional trailing actions. Used by memory-page and skills-page to avoid
 * duplicating the same Input + count pattern.
 */
export function FilterBar({
  value,
  onChange,
  placeholder,
  filteredCount,
  totalCount,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  filteredCount: number;
  totalCount: number;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 mt-3 flex shrink-0 items-center">
      <Input
        className="max-w-xs"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Filter…"}
        type="search"
        value={value}
      />
      <span className="text-muted-foreground ml-3 text-xs">
        {filteredCount}/{totalCount}
      </span>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}
