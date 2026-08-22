export const BLOCKED_PROTOCOLS = [
  "file:",
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "about:",
  "chrome:",
  "chrome-extension:",
] as const;

export const SAFE_PROTOCOLS = [
  "http:",
  "https:",
  "mailto:",
  "tel:",
  "sms:",
  "slack:",
  "discord:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "spotify:",
  "zoommtg:",
  "notion:",
  "obsidian:",
  "goose:",
] as const;

/**
 * Allow all protocols except BLOCKED — mirrors
 * `desktop/src/utils/urlSecurity.ts:75` + `desktop/src/components/MarkdownContent.tsx:168`.
 */
export function customUrlTransform(url: string): string {
  try {
    const protocol = new URL(url).protocol;
    if ((BLOCKED_PROTOCOLS as readonly string[]).includes(protocol)) {
      return "";
    }
  } catch {
    // relative URL or invalid — allow
  }
  return url;
}
