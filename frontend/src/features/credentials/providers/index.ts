import type { CredentialProvider } from "../types";

import { binanceCredential } from "./binance";

/**
 * Every credential the page renders, in display order. Adding one is a single
 * entry here — the page and card are generic.
 */
export const CREDENTIAL_PROVIDERS: CredentialProvider[] = [binanceCredential];
