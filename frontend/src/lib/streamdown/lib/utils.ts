import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export type CnFunction = (...inputs: ClassValue[]) => string;

/**
 * Prepends a prefix to each Tailwind utility class in a class string.
 * Used to support Tailwind v4's `prefix()` feature.
 *
 * @example
 * prefixClasses("tw", "flex items-center") // "tw:flex tw:items-center"
 * prefixClasses("tw", "dark:bg-red-500")   // "tw:dark:bg-red-500"
 */
export const prefixClasses = (prefix: string, classString: string): string => {
  if (!prefix || !classString) return classString;
  const prefixWithColon = `${prefix}:`;
  return classString
    .split(/\s+/)
    .filter(Boolean)
    .map((cls) => cls.startsWith(prefixWithColon) ? cls : `${prefix}:${cls}`)
    .join(" ");
};

/**
 * Creates a prefix-aware `cn` function. When no prefix is provided,
 * returns the standard `cn` with zero overhead.
 */
export const createCn = (prefix?: string): CnFunction => {
  if (!prefix) return cn;
  return (...inputs: ClassValue[]) => prefixClasses(prefix, twMerge(clsx(inputs)));
};

export const ACTION_BUTTON_CLASSES =
  "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

import { triggerDownload } from '@/lib/download';

export const save = triggerDownload;
