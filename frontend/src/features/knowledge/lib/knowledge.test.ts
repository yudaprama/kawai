import { describe, expect, it } from "vitest";
import { ADD_FILE_ACCEPT, classifySource, isTabularExt, isYouTubeUrl } from "@/features/knowledge/lib/knowledge";

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

  it("classifies tabular data extensions as files", () => {
    for (const name of ["sales.csv", "data.TSV", "ticks.parquet"]) {
      expect(classifySource(name, {}).kind).toBe("file");
    }
  });

  it("still rejects extensions the backend store does not accept (xlsm)", () => {
    expect(classifySource("macro.xlsm", {}).kind).toBe("unsupported");
  });
});

describe("isTabularExt", () => {
  it("covers every extension the analytics agent queries structurally", () => {
    for (const ext of ["csv", "tsv", "parquet", "xlsx", "xlsm"]) {
      expect(isTabularExt(ext)).toBe(true);
    }
  });

  it("is false for prose-indexed and unknown extensions", () => {
    for (const ext of ["docx", "pdf", "png", "md", "exe"]) {
      expect(isTabularExt(ext)).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isTabularExt("CSV")).toBe(true);
  });
});

describe("ADD_FILE_ACCEPT", () => {
  it("includes the tabular data extensions", () => {
    for (const ext of ["csv", "tsv", "parquet"]) {
      expect(ADD_FILE_ACCEPT).toContain(`.${ext}`);
    }
  });
});
