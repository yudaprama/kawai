import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import id from "@/locales/id.json";
import {
  formatRelativeTime,
  isPluralForms,
  setLocale,
  SUPPORTED_LOCALES,
  translate,
  type Locale,
  type TranslationKey,
} from "@/lib/i18n";

/** Flatten an en.json subtree into its leaf dot paths. */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (typeof node !== "object" || node === null) return [prefix];
  if (isPluralForms(node)) return [prefix];
  return Object.entries(node).flatMap(([key, value]) => leafPaths(value, prefix === "" ? key : `${prefix}.${key}`));
}

function sortedLeafPaths(dict: unknown): string[] {
  return leafPaths(dict).sort();
}

describe("locale dictionaries", () => {
  it("id.json covers every en.json key (no missing translations)", () => {
    expect(sortedLeafPaths(id)).toEqual(sortedLeafPaths(en));
  });

  it("every leaf resolves in every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of leafPaths(en)) {
        expect(translate(locale, key as TranslationKey, { count: 1 }), `${locale}:${key}`).not.toBe(key);
      }
    }
  });
});

describe("translate", () => {
  it("interpolates {{param}} placeholders", () => {
    expect(translate("en", "workbench.composer.placeholderChat", { agent: "analyst" })).toBe("Message analyst…");
  });

  it("selects plural forms from count", () => {
    expect(translate("en", "workbench.landing.runStepCount", { count: 1 })).toBe("1 step");
    expect(translate("en", "workbench.landing.runStepCount", { count: 4 })).toBe("4 steps");
    expect(translate("id", "workbench.landing.runStepCount", { count: 1 })).toBe("1 langkah");
    expect(translate("id", "workbench.landing.runStepCount", { count: 4 })).toBe("4 langkah");
  });

  it("returns the key itself for an unknown key instead of blanking", () => {
    expect(translate("en", "does.not.exist" as TranslationKey)).toBe("does.not.exist");
  });

  it("leaves an unknown placeholder untouched", () => {
    expect(translate("en", "toasts.runFailed", { bogus: 1 })).toBe("Run failed: {{error}}");
  });

  it("renders the id string for an id key (dictionary actually switches)", () => {
    expect(translate("id", "workbench.landing.recentRuns")).toBe("Jalankan terakhir");
    expect(translate("en", "workbench.landing.recentRuns")).toBe("Recent runs");
  });
});

describe("locale store", () => {
  it("setLocale switches the active locale", () => {
    setLocale("id");
    expect(translate("en" as Locale, "common.save")).toBe("Save");
    setLocale("en");
  });
});

describe("formatRelativeTime", () => {
  it("formats in the requested locale", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const threeMinutesAgo = now - 3 * 60 * 1000;
    expect(formatRelativeTime("en", threeMinutesAgo, now)).toBe("3 minutes ago");
    expect(formatRelativeTime("id", threeMinutesAgo, now)).toBe("3 menit yang lalu");
  });
});
