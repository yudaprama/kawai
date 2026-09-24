import { describe, expect, it } from "vitest";
import { unpackKnowledgeSearch } from "./knowledge";

describe("unpackKnowledgeSearch", () => {
  it("unpacks the {hits, note} envelope the tool emits", () => {
    const hits = [
      { source: "invoice.pdf", locator: "p.3", content: "Total due: 4200" },
      { source: "notes.md", locator: "L12", content: "Renewal date…" },
    ];
    expect(unpackKnowledgeSearch({ hits })).toEqual({ hits, note: null });
  });

  it("keeps the retry guidance carried by an empty search", () => {
    const { hits, note } = unpackKnowledgeSearch({ hits: [], note: "Retry with ONE distinctive keyword." });
    expect(hits).toEqual([]);
    expect(note).toBe("Retry with ONE distinctive keyword.");
  });

  it("accepts a bare hit array (pre-envelope persisted rows)", () => {
    const hit = { source: "a", locator: "b", content: "c" };
    expect(unpackKnowledgeSearch([hit])).toEqual({ hits: [hit], note: null });
  });

  it("drops malformed entries and reports nothing for non-hit payloads", () => {
    expect(unpackKnowledgeSearch({ hits: [{ source: "incomplete" }, 7, null] }).hits).toEqual([]);
    expect(unpackKnowledgeSearch({ note: "   " })).toEqual({ hits: [], note: null });
    expect(unpackKnowledgeSearch("plain text")).toEqual({ hits: [], note: null });
  });
});
