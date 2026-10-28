import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { YoutubeEmbed, linkifyTimestamps, youtubeSeekSeconds, youtubeWatchUrl } from "./youtube-embed";

/**
 * Render-level smoke for the YouTube Video Analysis canvas player. `renderToStaticMarkup`
 * never fires effects, so what this pins is the two user-visible states: the
 * facade must be a BUTTON (the whole point of click-to-load — no YouTube
 * player JS, no cookies until the user asks), and the srcdoc-free output must
 * not contain an iframe until activation.
 */
describe("YoutubeEmbed", () => {
  it("renders a click-to-load facade, not an iframe", () => {
    const html = renderToStaticMarkup(<YoutubeEmbed videoId="dQw4w9WgXcQ" title="My video" />);
    expect(html).toContain("<button");
    expect(html).toContain("i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie.com/embed");
  });

  it("labels the facade with the run goal", () => {
    const html = renderToStaticMarkup(<YoutubeEmbed videoId="dQw4w9WgXcQ" title="My video" />);
    expect(html).toContain(`aria-label="My video"`);
  });
});

/** The seek target the player hands to the YouTube widget must stay in sync
 *  with what `linkifyTimestamps` bakes into the markdown links. */
describe("timestamp link round trip", () => {
  it("every generated link resolves back to its seconds", () => {
    const videoId = "dQw4w9WgXcQ";
    const out = linkifyTimestamps("- 0:00 — intro\n- **25:30** — claim", videoId);
    for (const [ts, secs] of [
      ["0:00", 0],
      ["25:30", 1530],
    ] as const) {
      const m = new RegExp(`\\[${ts}\\]\\(([^)]+)\\)`).exec(out);
      expect(m, ts).not.toBeNull();
      expect(youtubeSeekSeconds(m?.[1] ?? "", videoId)).toBe(secs);
    }
    expect(out).toContain(youtubeWatchUrl(videoId, 1530));
  });
});
