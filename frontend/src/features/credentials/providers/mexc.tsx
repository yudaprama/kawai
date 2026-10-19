import type { CredentialProvider } from "../types";

/**
 * MEXC credentials — the user's OWN keys, stored in the LOCAL database only.
 *
 * The second credential on the page, and the deliberate difference from
 * Binance: MEXC is READ-ONLY today. No MEXC execution tool exists, so nothing
 * here arms order placement and the provider declares no `extra` settings
 * block (the field stays free for the day an execution tool lands).
 */
export const mexcCredential: CredentialProvider = {
  id: "mexc",
  icon: "landmark",
  titleKey: "credentials.mexc.title",
  subtitleKey: "credentials.mexc.subtitle",
  guideDetailKey: "credentials.mexc.guideDetail",
  guideKey: "credentials.mexc.guide",
  statusOp: "mexc_credentials_status",
  setOp: "mexc_credentials_set",
  deleteOp: "mexc_credentials_delete",
  fields: [
    { arg: "apiKey", labelKey: "credentials.apiKey", autoComplete: "off" },
    { arg: "apiSecret", labelKey: "credentials.apiSecret", autoComplete: "new-password" },
  ],
};