/**
 * Localized labels for the enum-shaped columns on a memory row.
 *
 * `kind`, `namespace`, `source` and `origin` are free-text columns: the
 * backend constrains them today, but a row written by an older build (or by
 * `memory_create_ns` from onboarding) can carry a value this frontend has
 * never heard of. `labelFor` therefore FALLS BACK to the raw value instead of
 * rendering a missing-i18n key — an unknown enum must still be readable, since
 * the raw string is exactly the information the user needs to make sense of it.
 */

import type { TranslationKey } from "@/lib/i18n";

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** `memories.kind` — matches `MEMORY_KINDS` in `lib/api.ts`. */
export const KIND_LABEL_KEYS = {
  preference: "memory.memoryKinds.preference",
  rule: "memory.memoryKinds.rule",
  event: "memory.memoryKinds.event",
  fact: "memory.memoryKinds.fact",
  goal: "memory.memoryKinds.goal",
} as const satisfies Record<string, TranslationKey>;

/** `memories.namespace` — the topical family a memory belongs to. */
export const NAMESPACE_LABEL_KEYS = {
  profile: "memory.namespaces.profile",
  people: "memory.namespaces.people",
  goals: "memory.namespaces.goals",
  episodic: "memory.namespaces.episodic",
  general: "memory.namespaces.general",
} as const satisfies Record<string, TranslationKey>;

/** `memories.source` — where the row came from. Mirrors `MEMORY_SOURCES`. */
export const SOURCE_LABEL_KEYS = {
  chat: "memory.source.chat",
  gmail: "memory.source.gmail",
  linkedin: "memory.source.linkedin",
  document: "memory.source.document",
  questions: "memory.source.questions",
  manual: "memory.source.manual",
  inferred: "memory.source.inferred",
} as const satisfies Record<string, TranslationKey>;

/**
 * `memories.origin` — HOW the row was written, which is a different question
 * from `source` (where it came from): `extracted` rows were distilled from a
 * transcript by the cloud tier, `consolidated` ones are the merge product of
 * `memory_consolidate`.
 */
export const ORIGIN_LABEL_KEYS = {
  manual: "memory.origin.manual",
  extracted: "memory.origin.extracted",
  consolidated: "memory.origin.consolidated",
} as const satisfies Record<string, TranslationKey>;

/** `profile_facets.user_state`. */
export const FACET_STATE_LABEL_KEYS = {
  active: "memory.facetState.active",
  pinned: "memory.facetState.pinned",
  dropped: "memory.facetState.dropped",
} as const satisfies Record<string, TranslationKey>;

/** Translate `value` through `table`, or return it verbatim when unmapped. */
export function labelFor(t: Translate, table: Readonly<Record<string, TranslationKey>>, value: string): string {
  const key = table[value];
  return key === undefined ? value : t(key);
}

export const kindLabel = (t: Translate, kind: string): string => labelFor(t, KIND_LABEL_KEYS, kind);
export const namespaceLabel = (t: Translate, namespace: string): string => labelFor(t, NAMESPACE_LABEL_KEYS, namespace);
export const sourceLabel = (t: Translate, source: string): string => labelFor(t, SOURCE_LABEL_KEYS, source);
export const originLabel = (t: Translate, origin: string): string => labelFor(t, ORIGIN_LABEL_KEYS, origin);
export const facetStateLabel = (t: Translate, state: string): string => labelFor(t, FACET_STATE_LABEL_KEYS, state);
