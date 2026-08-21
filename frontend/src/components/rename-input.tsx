import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";

interface RenameInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Invoked on Enter and on blur. */
  onCommit: () => void;
  /** Invoked on Escape. */
  onCancel: () => void;
  className?: string;
}

/**
 * Inline rename field used by sidebar session rows. Auto-focuses, commits on
 * Enter/blur and cancels on Escape.
 */
export function RenameInput({ value, onChange, onCommit, onCancel, className }: RenameInputProps) {
  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onCommit}
      className={className ?? "h-7"}
    />
  );
}
