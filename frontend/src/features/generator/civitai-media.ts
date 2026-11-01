/**
 * Civitai media assets the Generator panel must not surface.
 *
 * Civitai's CDN carries the asset's own id in the URL path
 * (`image.civitai.com/<bucket>/<asset-id>/…/<asset-id>.mp4`), so an asset is
 * matched by that path segment rather than by an API id: the community
 * galleries (`*_template_gallery`) hand back media URLs, not ids, and ONE
 * asset arrives twice — as its clip URL and as its poster/thumbnail URL —
 * so every URL a preset carries is checked, not just the playable one.
 */
const EXCLUDED_MEDIA_ASSET_IDS: readonly string[] = ["e5f297fe-05e1-400e-a49e-dca95e45e72a"];

/** True when a civitai media URL belongs to an excluded asset. */
export function isExcludedMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return EXCLUDED_MEDIA_ASSET_IDS.some((id) => url.includes(id));
}

/**
 * Drop every preset whose media is an excluded asset. `mediaUrls` returns the
 * URLs one preset owns (clip, poster, image) — a preset is dropped when ANY
 * of them matches, because a half-rendered tile (poster kept, clip gone) is
 * worse than no tile.
 */
export function filterExcludedMedia<T>(
  items: readonly T[],
  mediaUrls: (item: T) => Array<string | null | undefined>,
): T[] {
  return items.filter((item) => !mediaUrls(item).some(isExcludedMediaUrl));
}
