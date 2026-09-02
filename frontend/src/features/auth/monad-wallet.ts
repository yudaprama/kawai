/**
 * Monad hot-wallet login (SIWE / EIP-4361) — in-app EVM wallet signing.
 *
 * Trust model: the private key is generated and stored in the OS keychain by
 * the Rust backend (`monad_wallet_*` ops) and NEVER crosses to the frontend.
 * The frontend only composes the SIWE message, asks the backend to sign it,
 * and hands message+signature to `supabase.auth.signInWithWeb3`.
 */
import { call } from "@/lib/api";
import { supabase } from "@/features/auth/supabase";

export interface WalletAddress {
  address: string;
}

function randomNonce(): string {
  // 8 random bytes → 16 hex chars; the EIP-4361 nonce is an opaque string.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compose an EIP-4361 SIWE message. Domain = the webview origin host. */
function buildSiweMessage(address: string, statement: string): string {
  const domain = window.location.hostname || "localhost";
  const uri = window.location.origin || "kawai://auth";
  const issuedAt = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    statement,
    "",
    `URI: ${uri}`,
    "Version: 1",
    "Chain ID: 10143", // Monad testnet
    `Nonce: ${randomNonce()}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/**
 * Ensure a device wallet exists, then run the SIWE flow end-to-end:
 * create (if needed) → build message → backend signs → Supabase verifies
 * and issues the session. onAuthStateChange in use-auth picks up SIGNED_IN.
 */
export async function signInWithMonadWallet(): Promise<{ address: string }> {
  // Idempotent: returns the existing address when a wallet is already stored.
  const { address } = await call<WalletAddress>("monad_wallet_create");
  const message = buildSiweMessage(
    address,
    "Sign in to Kawai with your EVM wallet.",
  );
  const signature = await call<string>("monad_wallet_sign_message", {
    message,
  });
  const { error } = await supabase.auth.signInWithWeb3({
    chain: "ethereum",
    message,
    // The backend returns the EIP-191 65-byte hex signature (`0x…`).
    signature: signature as `0x${string}`,
  });
  if (error) throw error;
  return { address };
}
