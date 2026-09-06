import { call } from "@/lib/api";
import type { WalletStatus } from "./types";

// Adapter over the kawai Tauri monad_wallet commands. The backend is a single
// device-scoped hot wallet (key in the OS keychain) — no password, no
// mnemonic, no multi-wallet. Anything beyond that surface intentionally has no
// adapter method.

export interface WalletAdapter {
  /** Probe whether the monad feature is compiled into this build. */
  isAvailable(): Promise<boolean>;
  getStatus(): Promise<WalletStatus>;
  createWallet(): Promise<string>;
  deleteWallet(): Promise<void>;
  getCurrentAddress(): Promise<string>;
}

export const tauriWalletAdapter: WalletAdapter = {
  async isAvailable(): Promise<boolean> {
    try {
      await call("monad_chain_status", { rpcUrl: null });
      return true;
    } catch {
      return false;
    }
  },
  async getStatus(): Promise<WalletStatus> {
    const addr = await call<string | { address?: string } | null>("monad_wallet_address");
    const address = typeof addr === "string" ? addr : (addr?.address ?? "");
    return {
      hasWallet: !!address,
      isLocked: false,
      address,
      wallets: address ? [{ address, description: "Primary", isActive: true }] : [],
    };
  },
  async createWallet(): Promise<string> {
    const r = await call<string | { address?: string }>("monad_wallet_create");
    return typeof r === "string" ? r : (r?.address ?? "");
  },
  async deleteWallet(): Promise<void> {
    await call("monad_wallet_delete");
  },
  async getCurrentAddress(): Promise<string> {
    const s = await this.getStatus();
    return s.address;
  },
};
