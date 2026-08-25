import { describe, expect, it } from "vitest";
import { classifySource, isYouTubeUrl } from "@/lib/knowledge";

describe("isYouTubeUrl", () => {
  it("accepts known YouTube hosts", () => {
    for (const url of [
      "https://youtube.com/watch?v=x",
      "https://www.youtube.com/watch?v=x",
      "https://m.youtube.com/watch?v=x",
      "https://youtu.be/x",
    ]) {
      expect(isYouTubeUrl(url)).toBe(true);
    }
  });

  it("rejects other hosts and garbage", () => {
    expect(isYouTubeUrl("https://vimeo.com/1")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});

describe("classifySource", () => {
  it("classifies office extensions as files with path source", () => {
    const s = classifySource("report.docx", { path: "/tmp/report.docx" });
    expect(s).toEqual({
      kind: "file",
      name: "report.docx",
      sourcePath: "/tmp/report.docx",
    });
  });

  it("classifies image extensions as files carrying the File", () => {
    const file = new File(["x"], "p.png");
    const s = classifySource("p.png", { file });
    expect(s).toEqual({ kind: "file", name: "p.png", file });
  });

  it("marks unsupported extensions", () => {
    expect(classifySource("virus.exe", {})).toEqual({
      kind: "unsupported",
      name: "virus.exe",
    });
  });

  it("is case-insensitive on extension", () => {
    expect(classifySource("A.PDF", {}).kind).toBe("file");
  });
});
