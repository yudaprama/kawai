import type { ReactNode } from "react";

import type { TranslationKey } from "@/lib/i18n";

/**
 * Credentials page — provider contract.
 *
 * One page, many providers. A provider declares its own title, the ops that
 * read/write/clear its keys, the input fields the set op takes, and (optionally)
 * a provider-specific settings block rendered under the key form. The page and
 * the card own everything else: the status badge, the save/remove flow, the
 * error/notice surface. Adding a second credential is a new entry in
 * `providers/index.ts` — no page or card change.
 *
 * This is the FRONTEND view of the contract. The backend stays per-provider
 * ops (`binance_credentials_set/status/delete`) — a generic secret store would
 * have to store, mask and validate secrets generically too, and no second
 * provider needs that yet.
 */

/** Where a provider's active key pair comes from — the same three states for
 *  every provider: the user's own, the product's baked fallback, or nothing.
 *  The secret NEVER crosses this boundary; only the source + masked preview. */
export type CredentialSource = "user" | "baked" | "none";

/** What `statusOp` returns (see `CredentialProvider.statusOp`). */
export interface CredentialStatus {
  source: CredentialSource;
  /** Masked key preview for display, e.g. `ABC1…9F2D`. Null when unset. */
  keyPreview: string | null;
}

/** One input on the key form. `arg` is the camelCase key the set op receives. */
export interface CredentialField {
  /** camelCase arg name sent to `setOp`. */
  arg: string;
  labelKey: TranslationKey;
  /** Autocomplete hint — secrets use `new-password` so a password manager
   *  never offers to fill a credential it happens to store. */
  autoComplete: "off" | "new-password";
}

export interface CredentialProvider {
  /** Stable id — also the card's React key. */
  id: string;
  /** Lucide icon name (see `components/shared/icon.tsx`). */
  icon: string;
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
  /** How to obtain the key, and what NOT to enable. */
  guideKey: TranslationKey;
  /** Op returning `CredentialStatus`. */
  statusOp: string;
  /** Op taking one arg per field; clears both fields to "" on success. */
  setOp: string;
  /** Op removing the stored credentials. */
  deleteOp: string;
  fields: CredentialField[];
  /** Provider-specific settings rendered under the key form (e.g. a toggle).
   *  Self-contained: owns its own read/write ops and state. */
  extra?: ReactNode;
}
