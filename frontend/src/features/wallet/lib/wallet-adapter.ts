import { call } from "@/lib/api";
import type { WalletInfo, WalletStatus } from "./types";

// Adapter over kawai tauri monad_wallet commands + veridium-compatible surface.
// Veridium: WalletService.*  (Wails). Kawai: monad_wallet_* (Tauri).
// This adapter lets UI stay agnostic; we map single hot-wallet to multi-wallet shape.

export interface WalletAdapter {
  getStatus(): Promise<WalletStatus>;
  hasWallet(): Promise<boolean>;
  isUnlocked(): Promise<boolean>;
  getCurrentAddress(): Promise<string>;
  getWallets(): Promise<WalletInfo[]>;
  createWallet(password: string, mnemonic: string, description?: string): Promise<string>;
  setupWallet(password: string, mnemonic: string, name?: string): Promise<string>;
  generateMnemonic(): Promise<string>;
  unlockWallet(password: string): Promise<string>;
  lockWallet(): Promise<void>;
  switchWallet(address: string, password: string): Promise<string>;
  deleteWallet(address: string): Promise<void>;
  exportKeystore(address: string): Promise<string>;
  importKeystore(keystoreJSON: string, password: string, description?: string): Promise<string>;
  importPrivateKey(privateKeyHex: string, password: string, description?: string): Promise<string>;
  updateWalletDescription(address: string, description: string): Promise<void>;
  getAPIKey(): Promise<string>;
  signMessage(message: string): Promise<string>;
  getUserBalanceInfo(): Promise<import("./types").UserBalanceInfo | null>;
  autoClaimTrialIfNeeded(referralCode: string): Promise<[boolean, number, string]>;
  getCurrentAccountAddress(): Promise<string>;
}

async function tryCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await call<T>(cmd, args);
  } catch {
    return null;
  }
}

export const tauriWalletAdapter: WalletAdapter = {
  async getStatus(): Promise<WalletStatus> {
    // Try veridium-style first, then kawai single-wallet
    const s = await tryCall<WalletStatus>("get_wallet_status");
    if (s) return s;
    const addr = await tryCall<{ address: string } | string>("monad_wallet_address");
    const address = typeof addr === "string" ? addr : ((addr as { address?: string })?.address ?? "");
    const has = !!address;
    return {
      hasWallet: has,
      isLocked: !has,
      address: address || "",
      wallets: has ? [{ address, description: "Primary", isActive: true }] : [],
    };
  },
  async hasWallet(): Promise<boolean> {
    const s = await this.getStatus();
    return s.hasWallet;
  },
  async isUnlocked(): Promise<boolean> {
    const s = await this.getStatus();
    return !s.isLocked;
  },
  async getCurrentAddress(): Promise<string> {
    const a = await tryCall<string>("monad_wallet_address");
    if (typeof a === "string" && a) return a;
    const s = await this.getStatus();
    return s.address;
  },
  async getWallets(): Promise<WalletInfo[]> {
    const s = await this.getStatus();
    return s.wallets;
  },
  async createWallet(password: string, mnemonic: string, description?: string): Promise<string> {
    // kawai currently idempotent create (no password/mnemonic). Use fallback if command missing.
    const r = await tryCall<{ address: string } | string>("monad_wallet_create", { password, mnemonic, description });
    if (r) return typeof r === "string" ? r : ((r as { address?: string }).address ?? "");
    // fallback: create then return address
    const addr = await call<string | { address: string }>("monad_wallet_create", {});
    return typeof addr === "string" ? addr : ((addr as { address?: string }).address ?? "");
  },
  async setupWallet(password: string, mnemonic: string, name?: string): Promise<string> {
    return this.createWallet(password, mnemonic, name);
  },
  async generateMnemonic(): Promise<string> {
    const m = await tryCall<string>("generate_mnemonic");
    if (m) return m;
    // client-side fallback — NOT secure, only for dev unless backend provides real
    const words = [
      "abandon",
      "ability",
      "able",
      "about",
      "above",
      "absent",
      "absorb",
      "abstract",
      "absurd",
      "abuse",
      "access",
      "accident",
    ];
    return words.slice(0, 12).join(" ");
  },
  async unlockWallet(_password: string): Promise<string> {
    // single hot wallet is always unlocked after create; no-op
    return this.getCurrentAddress();
  },
  async lockWallet(): Promise<void> {
    // no-op for hot wallet
  },
  async switchWallet(address: string): Promise<string> {
    return address;
  },
  async deleteWallet(_address: string): Promise<void> {
    await call("monad_wallet_delete").catch(() => {});
  },
  async exportKeystore(_address: string): Promise<string> {
    throw new Error("Export keystore not available in kawai backend yet");
  },
  async importKeystore(): Promise<string> {
    throw new Error("Import keystore not available yet");
  },
  async importPrivateKey(): Promise<string> {
    throw new Error("Import private key not available yet");
  },
  async updateWalletDescription(): Promise<void> {
    // no-op
  },
  async getAPIKey(): Promise<string> {
    const k = await tryCall<string>("get_api_key");
    return k ?? "";
  },
  async signMessage(message: string): Promise<string> {
    return call<string>("monad_wallet_sign_message", { message });
  },
  async getUserBalanceInfo() {
    const b = await tryCall<import("./types").UserBalanceInfo>("get_user_balance_info");
    return b;
  },
  async autoClaimTrialIfNeeded(): Promise<[boolean, number, string]> {
    const r = await tryCall<[boolean, number, string]>("auto_claim_trial_if_needed", { referralCode: "" });
    return r ?? [false, 0, "0"];
  },
  async getCurrentAccountAddress(): Promise<string> {
    return this.getCurrentAddress();
  },
};
