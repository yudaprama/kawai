import { CONNECTOR_APPS } from "../constants";
import { ConnectorConnectBanner } from "./connector-connect-banner";

/**
 * Companion hint for a composio_* step's tool view: derive the toolkit slugs
 * the step touched and mount the "Connect X to continue" banner for any of
 * them the user hasn't connected (renders nothing otherwise). Derivation is
 * deliberately conservative — only slugs that match an offered CONNECTOR_APPS
 * toolkit are ever surfaced:
 *
 * 1. structured output fields (`app` / `toolkit` / `toolkitSlug`),
 * 2. UPPER_SNAKE action tokens in the raw output (GMAIL_SEND_EMAIL → gmail).
 */
export function ComposioConnectHint({ data, raw }: { data: unknown; raw: string }) {
  const known: Set<string> = new Set(CONNECTOR_APPS.map((a) => a.toolkit));
  const found = new Set<string>();

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const field of [obj.app, obj.toolkit, obj.toolkitSlug]) {
      if (typeof field === "string") {
        const slug = field.toLowerCase();
        if (known.has(slug)) found.add(slug);
      }
    }
  }

  for (const m of raw.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    const slug = m[0].split("_")[0].toLowerCase();
    if (known.has(slug)) found.add(slug);
  }

  if (found.size === 0) return null;
  return <ConnectorConnectBanner toolkits={[...found]} />;
}
