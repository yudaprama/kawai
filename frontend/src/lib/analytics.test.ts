import { describe, expect, it } from "vitest";
import { detectQueryChart, isRemoteSource, maskSource, rowsToCsv } from "@/lib/analytics";

describe("detectQueryChart", () => {
  it("detects a dim + measure result", () => {
    const rows = [
      { kategori: "makanan", total: 1500 },
      { kategori: "minuman", total: 800 },
      { kategori: "snack", total: 320 },
    ];
    expect(detectQueryChart(rows)).toEqual({
      dim: "kategori",
      measure: "total",
      labels: ["makanan", "minuman", "snack"],
      values: [1500, 800, 320],
    });
  });

  it("accepts date-like dims and skips non-numeric measure rows", () => {
    const rows = [
      { bulan: "2026-01", total: 1 },
      { bulan: "2026-02", total: 2 },
      { bulan: "2026-03", total: null },
      { bulan: "2026-04", total: 4 },
      { bulan: "2026-05", total: 5 },
    ];
    const spec = detectQueryChart(rows);
    expect(spec?.labels).toEqual(["2026-01", "2026-02", "2026-04", "2026-05"]);
    expect(spec?.values).toEqual([1, 2, 4, 5]);
  });

  it("rejects 3-column results", () => {
    const rows = [
      { a: "x", b: 1, c: 2 },
      { a: "y", b: 3, c: 4 },
    ];
    expect(detectQueryChart(rows)).toBeNull();
  });

  it("rejects numeric dims (no categorical axis)", () => {
    const rows = [
      { year: 2024, total: 1 },
      { year: 2025, total: 2 },
    ];
    expect(detectQueryChart(rows)).toBeNull();
  });

  it("rejects a single row and empty input", () => {
    expect(detectQueryChart([{ a: "x", b: 1 }])).toBeNull();
    expect(detectQueryChart([])).toBeNull();
  });

  it("rejects mostly non-numeric measures", () => {
    const rows = [
      { a: "x", b: "nope" },
      { a: "y", b: 2 },
    ];
    expect(detectQueryChart(rows)).toBeNull();
  });
});

describe("rowsToCsv", () => {
  it("serializes headers and primitive cells", () => {
    const csv = rowsToCsv([
      { kategori: "makanan", total: 1500 },
      { kategori: "minuman", total: 800.5 },
    ]);
    expect(csv).toBe("kategori,total\nmakanan,1500\nminuman,800.5");
  });

  it("escapes commas, quotes and newlines", () => {
    const csv = rowsToCsv([{ name: 'a "b", c\nd', n: 1 }]);
    expect(csv).toBe('name,n\n"a ""b"", c\nd",1');
  });

  it("renders null/undefined as empty cells and objects as quoted JSON", () => {
    const csv = rowsToCsv([{ a: null, b: undefined, c: { x: 1 } }]);
    expect(csv).toBe('a,b,c\n,,"{""x"":1}"');
  });

  it("returns empty string for no rows", () => {
    expect(rowsToCsv([])).toBe("");
  });
});

describe("isRemoteSource", () => {
  it("matches postgres/mysql schemes case-insensitively", () => {
    expect(isRemoteSource("postgres://u@h/db")).toBe(true);
    expect(isRemoteSource("MySQL://u@h/db")).toBe(true);
    expect(isRemoteSource("mariadb://u@h/db")).toBe(true);
  });

  it("does not match sqlite paths", () => {
    expect(isRemoteSource("/tmp/keuangan.db")).toBe(false);
    expect(isRemoteSource("sqlite:/tmp/x.db")).toBe(false);
  });
});

describe("maskSource", () => {
  it("redacts inline passwords", () => {
    expect(maskSource("postgres://user:secret@host/db")).toBe("postgres://user:***@host/db");
  });

  it("leaves credential-less URLs and paths unchanged", () => {
    expect(maskSource("postgres://user@host/db")).toBe("postgres://user@host/db");
    expect(maskSource("/tmp/keuangan.db")).toBe("/tmp/keuangan.db");
  });
});
