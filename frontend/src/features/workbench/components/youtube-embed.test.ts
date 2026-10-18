import { describe, expect, it } from "vitest";

import { linkifyTimestamps, timestampSeconds, youtubeSeekSeconds, youtubeWatchUrl } from "./youtube-embed";

describe("timestampSeconds", () => {
  it("parses mm:ss and h:mm:ss", () => {
    expect(timestampSeconds("0:00")).toBe(0);
    expect(timestampSeconds("12:34")).toBe(754);
    expect(timestampSeconds("1:01:01")).toBe(3661);
  });

  it("rejects non-timestamps", () => {
    expect(timestampSeconds("16:9")).toBeNull(); // 9 is not a valid second
    expect(timestampSeconds("3.45")).toBeNull();
    expect(timestampSeconds("abc")).toBeNull();
  });
});

describe("youtubeWatchUrl / youtubeSeekSeconds round trip", () => {
  it("builds the canonical watch link and reads seconds back", () => {
    const url = youtubeWatchUrl("dQw4w9WgXcQ", 754);
    expect(url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s");
    expect(youtubeSeekSeconds(url, "dQw4w9WgXcQ")).toBe(754);
  });

  it("keeps t=0s when explicitly given, omits it when absent", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ", 0)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s");
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("rejects other videos and links without a t", () => {
    expect(youtubeSeekSeconds("https://www.youtube.com/watch?v=OTHER&t=10s", "dQw4w9WgXcQ")).toBeNull();
    expect(youtubeSeekSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ")).toBeNull();
    expect(youtubeSeekSeconds("https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ")).toBe(42);
    expect(youtubeSeekSeconds("https://example.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ")).toBeNull();
  });
});

describe("linkifyTimestamps", () => {
  const md = [
    "## Timestamps",
    "",
    "- 0:00 — Intro",
    "- **1:23** — The claim",
    "2. 12:34 — The evidence",
    "  * 1:01:01 — Q&A",
    "",
    "The ratio 16:9 stays untouched, as does mid-line 4:20 text.",
    "",
    "```",
    "- 5:00 — inside a code fence: data, not navigation",
    "```",
  ].join("\n");

  it("links leading list-item timestamps only", () => {
    const out = linkifyTimestamps(md, "dQw4w9WgXcQ");
    expect(out).toContain("- [0:00](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s) — Intro");
    // bold markers survive around the link
    expect(out).toContain("- **[1:23](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s)** — The claim");
    expect(out).toContain("2. [12:34](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s)");
    expect(out).toContain("* [1:01:01](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3661s)");
  });

  it("leaves mid-line numbers and fenced blocks alone", () => {
    const out = linkifyTimestamps(md, "dQw4w9WgXcQ");
    expect(out).toContain("The ratio 16:9 stays untouched, as does mid-line 4:20 text.");
    expect(out).toContain("- 5:00 — inside a code fence: data, not navigation");
  });
});
