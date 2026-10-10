import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryLayerTabs, MemoryRow } from "./memory-page";
import { facetStateLabel, kindLabel, namespaceLabel, originLabel, sourceLabel } from "../lib/labels";
import { Tabs } from "@/components/ui/tabs";
import type { MemoryTab } from "./memory-page";
import { setLocale, translate, type Locale, type TranslationKey } from "@/lib/i18n";
import type { MemoryItem } from "@/lib/api";

/**
 * Render-level smoke for the Memory page's two hardest-to-notice surfaces.
 *
 * The layer strip: seven labels never fit a narrow split pane, so a regression
 * that drops the overflow treatment silently hides the LAST tab — the graph,
 * which is the one layer with no other entry point. Every layer must therefore
 * stay present AND named, and the row must stay a horizontal scroller.
 *
 * The memory row: `pinned` / `namespace` / `source` decide whether an agent is
 * actually told a fact, so a row that renders only `kind` looks complete while
 * destroying the user's ability to audit what Kawai knows. `origin` is the
 * separate how-was-this-written answer. Pinned state in particular has no
 * other surface on the page, so its absence is invisible rather than broken.
 */

const t = (key: TranslationKey, params?: Record<string, string | number>) => translate("en", key, params);

const memory = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "mem-1",
  kind: "preference",
  title: "Prefers dark UIs",
  content: "Always ships dark-mode-first interfaces.",
  sourceSessionId: 7,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
  confidence: 0.9,
  accessCount: 3,
  lastAccessedAt: null,
  origin: "extracted",
  namespace: "profile",
  pinned: false,
  source: "chat",
  ...over,
});

const tabStrip = (tab: MemoryTab) =>
  renderToStaticMarkup(
    <Tabs onValueChange={() => {}} value={tab}>
      <MemoryLayerTabs tab={tab} />
    </Tabs>,
  );

const row = (over: Partial<MemoryItem> = {}, armed = false) =>
  renderToStaticMarkup(<MemoryRow armed={armed} item={memory(over)} onDelete={() => {}} onEdit={() => {}} />);

describe("MemoryLayerTabs", () => {
  const html = tabStrip("l1");

  it("names every layer so none can go missing from the strip", () => {
    for (const label of [
      "Conversations (L0)",
      "Memories (L1)",
      "Scenes (L2)",
      "Persona (L3)",
      "Profile",
      "Experiences",
      "Graph",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("keeps the strip a horizontal scroller rather than letting it clip", () => {
    // Without this the seventh tab is unreachable at narrow split widths.
    expect(html).toContain("overflow-x-auto");
    // Triggers must not be squeezed by flex, or the labels truncate.
    expect(html).toContain("w-max");
  });

  it("marks exactly the selected layer as current", () => {
    const onL0 = tabStrip("l0");
    expect(onL0.match(/data-state="active"/g)).toHaveLength(1);
    expect(onL0).toContain('role="tab"');
  });
});

describe("MemoryRow", () => {
  it("shows the three fields that decide whether an agent is told this fact", () => {
    const html = row();
    expect(html).toContain(kindLabel(t, "preference"));
    expect(html).toContain(namespaceLabel(t, "profile"));
    expect(html).toContain(sourceLabel(t, "chat"));
  });

  it("distinguishes how the row was written from where it came from", () => {
    // "Extracted" (distilled from a transcript) is a different claim from
    // "Chat" (its provenance) — collapsing them would misreport the row.
    const html = row();
    expect(html).toContain(originLabel(t, "extracted"));
    expect(html).not.toContain(">extracted<");
  });

  it("marks a pinned memory, and leaves an unpinned one unmarked", () => {
    expect(row({ pinned: true })).toContain(t("memory.pinned"));
    expect(row({ pinned: false })).not.toContain(t("memory.pinned"));
  });

  it("names the source block for a row extracted from one", () => {
    expect(row({ sourceSessionId: 7 })).toContain(t("memory.blockLabel", { id: 7 }));
    expect(row({ sourceSessionId: null })).not.toContain(t("memory.blockLabel", { id: 7 }));
  });

  it("gives each row action a distinct accessible name", () => {
    const html = row({ title: "Prefers dark UIs" });
    expect(html).toContain(t("memory.editMemoryAria", { title: "Prefers dark UIs" }));
    expect(html).toContain(t("memory.deleteMemoryAria", { title: "Prefers dark UIs" }));
  });

  it("reveals a visible confirm label once delete is armed", () => {
    // The old affordance armed on a `title` tooltip alone, which no touch user
    // and no keyboard user ever sees.
    expect(row({}, true)).toContain(t("memory.confirmAgain"));
    expect(row({}, false)).not.toContain(t("memory.confirmAgain"));
  });

  it("keeps an unknown enum readable instead of rendering a raw i18n key", () => {
    const html = row({ namespace: "workspace" });
    expect(html).toContain("workspace");
    expect(html).not.toContain("memory.namespaces.workspace");
  });
});

describe("enum labels", () => {
  const locales: Locale[] = ["en", "id"];

  it.each(locales)("resolves every known enum value in %s", (locale) => {
    for (const value of ["preference", "rule", "event", "fact", "goal"]) {
      expect(kindLabel((k, p) => translate(locale, k, p), value)).not.toBe(value);
    }
    for (const value of ["profile", "people", "goals", "episodic", "general"]) {
      expect(namespaceLabel((k, p) => translate(locale, k, p), value)).not.toBe(value);
    }
    for (const value of ["chat", "gmail", "linkedin", "document", "questions", "manual", "inferred"]) {
      expect(sourceLabel((k, p) => translate(locale, k, p), value)).not.toBe(value);
    }
    for (const value of ["manual", "extracted", "consolidated"]) {
      expect(originLabel((k, p) => translate(locale, k, p), value)).not.toBe(value);
    }
    for (const value of ["active", "pinned", "dropped"]) {
      expect(facetStateLabel((k, p) => translate(locale, k, p), value)).not.toBe(value);
    }
  });

  it("falls back to the raw value for an enum this build has never seen", () => {
    const tr = (k: TranslationKey) => translate("en", k);
    expect(kindLabel(tr, "vibe")).toBe("vibe");
    expect(sourceLabel(tr, "telepathy")).toBe("telepathy");
  });

  it("actually switches dictionary — an Indonesian user reads Indonesian rows", () => {
    setLocale("id");
    try {
      const tr = (k: TranslationKey) => translate("id", k);
      expect(kindLabel(tr, "preference")).toBe("Preferensi");
      expect(namespaceLabel(tr, "profile")).toBe("Profil");
      expect(sourceLabel(tr, "linkedin")).toBe("LinkedIn");
      expect(originLabel(tr, "consolidated")).toBe("Digabungkan");
    } finally {
      setLocale("en");
    }
  });
});
