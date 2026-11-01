import { describe, expect, it } from "vitest";

import { filterExcludedMedia, isExcludedMediaUrl } from "./civitai-media";

/**
 * The generator's community galleries are civitai media, so an asset that
 * must not be shown has to be dropped by URL — the presets carry no id. The
 * same asset is served under several paths (the clip, its poster render), so
 * matching one exact string would leave the tile behind.
 */

const CLIP =
  "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/e5f297fe-05e1-400e-a49e-dca95e45e72a/original=true/e5f297fe-05e1-400e-a49e-dca95e45e72a.mp4";
const POSTER =
  "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/e5f297fe-05e1-400e-a49e-dca95e45e72a/width=450/e5f297fe-05e1-400e-a49e-dca95e45e72a.jpeg";
const OTHER =
  "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/0d1c5a60-7b6c-4a3c-9a2f-1c8cbb7ad0f1/original=true/0d1c5a60-7b6c-4a3c-9a2f-1c8cbb7ad0f1.mp4";

describe("isExcludedMediaUrl", () => {
  it("matches the excluded asset's clip URL", () => {
    expect(isExcludedMediaUrl(CLIP)).toBe(true);
  });

  it("matches the same asset under its poster path", () => {
    // Different path, same asset id — the gallery tile would survive an
    // exact-URL comparison and render a broken half.
    expect(isExcludedMediaUrl(POSTER)).toBe(true);
  });

  it("leaves other civitai media alone", () => {
    expect(isExcludedMediaUrl(OTHER)).toBe(false);
  });

  it("treats missing and empty URLs as not excluded", () => {
    expect(isExcludedMediaUrl(null)).toBe(false);
    expect(isExcludedMediaUrl(undefined)).toBe(false);
    expect(isExcludedMediaUrl("")).toBe(false);
  });
});

describe("filterExcludedMedia", () => {
  const urlsOf = (p: { url?: string | null; thumbnail?: string | null }) => [p.url, p.thumbnail];

  it("drops a preset whose clip OR poster is the excluded asset", () => {
    const rows = [
      { url: OTHER, thumbnail: OTHER },
      { url: CLIP, thumbnail: OTHER },
      { url: OTHER, thumbnail: POSTER },
    ];
    expect(filterExcludedMedia(rows, urlsOf)).toEqual([{ url: OTHER, thumbnail: OTHER }]);
  });

  it("returns an empty list rather than throwing on an empty gallery", () => {
    expect(filterExcludedMedia([], urlsOf)).toEqual([]);
  });
});
