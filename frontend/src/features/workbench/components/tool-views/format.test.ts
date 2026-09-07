import { describe, expect, it } from "vitest";

import { fmtBytes, fmtPct, isRecord, parseMaybeJson } from "./format";

describe("parseMaybeJson", () => {
  it("parses intact JSON", () => {
    expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMaybeJson("[1,2]")).toEqual([1, 2]);
  });

  it("returns the raw string for non-JSON", () => {
    expect(parseMaybeJson("- (fact | mem_1) Judul: isi")).toBe("- (fact | mem_1) Judul: isi");
    expect(parseMaybeJson("")).toBe("");
  });

  it("repairs JSON cut off inside a string value", () => {
    const cut = '{"pages":{"1":"halaman satu","2":"halaman dua terpotong di tengah ka';
    const v = parseMaybeJson(cut);
    expect(isRecord(v)).toBe(true);
    expect((v as Record<string, unknown>).pages).toMatchObject({ "1": "halaman satu" });
  });

  it("repairs JSON cut off after a complete pair", () => {
    const v = parseMaybeJson('{"a":1,"b":{"c":"x",');
    expect(v).toEqual({ a: 1, b: { c: "x" } });
  });

  it("repairs a cut top-level array", () => {
    const v = parseMaybeJson('[{"title":"satu"},{"title":"dua"},{"tit');
    expect(v).toEqual([{ title: "satu" }, { title: "dua" }]);
  });

  it("gives up gracefully on garbage that starts like JSON", () => {
    expect(parseMaybeJson("{not json at all}")).toBe("{not json at all}");
  });
});

describe("formatters", () => {
  it("formats percent in id-ID with sign", () => {
    expect(fmtPct(2.34)).toMatch(/^(\+)?2,34%$/);
    expect(fmtPct(-1.05)).toContain("-1,05%");
  });

  it("formats bytes", () => {
    expect(fmtBytes(500)).toBe("500 B");
    expect(fmtBytes(1536)).toMatch(/^1,5 KB$/);
  });
});
