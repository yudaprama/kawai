import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses JSON, returning the original string unchanged if it isn't valid JSON
 * (so callers can fall back to treating it as plain text).
 */
export function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Best-effort error message extraction (handles Error, string, or unknown). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

/** Reads a response body as text, returning '' if it can't be read. */
export async function textOrEmpty(res: Response): Promise<string> {
  return res.text().catch(() => '')
}

/** Reads a response body as JSON, returning `{}` if it can't be parsed. */
export async function jsonOrEmpty<T extends object>(res: Response): Promise<T> {
  return res.json().catch(() => ({}) as T)
}

/** Formats an ISO date string to a short "month day" (or "month day, year" if not the current year). */
export function formatModified(iso?: string, fallback = '—'): string {
  if (!iso) return fallback
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return fallback
  const d = new Date(ts)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * Formats a unix timestamp (seconds) as relative time ("just now", "5m ago",
 * "3h ago", "2d ago") then falls back to "month day" for older dates.
 */
export function formatRelativeTime(unixSec?: number): string {
  if (!unixSec) return ''
  const d = new Date(unixSec * 1000)
  const now = Date.now()
  const diffMs = now - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
