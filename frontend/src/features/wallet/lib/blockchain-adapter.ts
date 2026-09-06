import { call } from "@/lib/api";
import type { BalanceInfo, GasEstimate, NetworkInfo, TokenInfo } from "./types";

// Mirrors veridium JarvisService + DeAIService surface, backed by kawai tauri commands.
// Missing commands return null / throw — UI shows graceful fallback.

export interface BlockchainAdapter {
  getSupportedNetworks(): Promise<NetworkInfo[]>;
  getNetworkByID(chainId: number): Promise<NetworkInfo | null>;
  getNativeBalance(address: string, networkId: number): Promise<BalanceInfo | null>;
  getTokenBalance(token: string, wallet: string, networkId: number): Promise<BalanceInfo | null>;
  getTokenPrice(token: string, networkId: number): Promise<number>;
  getTokenInfo(token: string, networkId: number): Promise<TokenInfo | null>;
  estimateGas(networkId: number): Promise<GasEstimate | null>;
  getCurrentBlock(networkId: number): Promise<number>;
  analyzeTransaction(txHash: string, networkId: number): Promise<unknown | null>;
  getVaultBalance(): Promise<string>;
  depositToVault(rawAmount: string): Promise<string>;
  transferNative(to: string, amount: string): Promise<string>;
  transferUSDT(to: string, rawAmount: string): Promise<string>;
  transferToken(token: string, to: string, rawAmount: string): Promise<string>;
  getClaimableRewards?(): Promise<unknown>;
  syncDeposit(txHash: string, userAddress: string): Promise<{ success: boolean; newBalance?: string } | null>;
}

async function tryCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await call<T>(cmd, args);
  } catch {
    return null;
  }
}

export const tauriBlockchainAdapter: BlockchainAdapter = {
  async getSupportedNetworks(): Promise<NetworkInfo[]> {
    const r = await tryCall<NetworkInfo[]>("get_supported_networks");
    if (r) return r;
    // fallback: single Monad testnet
    return [
      {
        id: 10143,
        name: "Monad Testnet",
        nativeTokenSymbol: "MON",
        nativeTokenDecimal: 18,
        explorerURL: "https://testnet.monadexplorer.com",
        isTestnet: true,
        icon: "monad",
        stablecoinSymbol: "USDT",
        stablecoinName: "Tether USD",
        stablecoinShort: "USDT",
      },
    ];
  },
  async getNetworkByID(chainId: number): Promise<NetworkInfo | null> {
    const r = await tryCall<NetworkInfo>("get_network_by_id", { chainId });
    if (r) return r;
    const all = await this.getSupportedNetworks();
    return all.find((n) => n.id === chainId) ?? null;
  },
  async getNativeBalance(address: string, networkId: number): Promise<BalanceInfo | null> {
    // kawai has check_monad_balance
    const r = await tryCall<{ raw: string; formatted: string; decimals: number }>("check_monad_balance", {
      walletAddress: address,
      rpcUrl: null,
    });
    if (r) return r;
    const fallback = await tryCall<BalanceInfo>("get_native_balance", { address, networkId });
    return fallback;
  },
  async getTokenBalance(tokenAddress: string, walletAddress: string, networkId: number): Promise<BalanceInfo | null> {
    return tryCall<BalanceInfo>("get_token_balance", { tokenAddress, walletAddress, networkId });
  },
  async getTokenPrice(token: string, networkId: number): Promise<number> {
    const p = await tryCall<number>("get_token_price", { token, networkId });
    return p ?? 0;
  },
  async getTokenInfo(tokenAddress: string, networkId: number): Promise<TokenInfo | null> {
    return tryCall<TokenInfo>("get_token_info", { tokenAddress, networkId });
  },
  async estimateGas(networkId: number): Promise<GasEstimate | null> {
    const g = await tryCall<GasEstimate>("estimate_gas", { networkId });
    if (g) return g;
    // kawai monad_chain_status may include gas? fallback static
    return { maxGasPriceGwei: 12, maxTipGwei: 1, isDynamicFee: true };
  },
  async getCurrentBlock(networkId: number): Promise<number> {
    const b = await tryCall<number>("get_current_block", { networkId });
    if (b != null) return b;
    const s = await tryCall<{ blockHeight: number }>("monad_chain_status", { rpcUrl: null });
    return (s as { blockHeight?: number } | null)?.blockHeight ?? 0;
  },
  async analyzeTransaction(txHash: string, networkId: number): Promise<unknown | null> {
    return tryCall("analyze_transaction", { txHash, networkId });
  },
  async getVaultBalance(): Promise<string> {
    const b = await tryCall<string>("get_vault_balance");
    return b ?? "0.00";
  },
  async depositToVault(rawAmount: string): Promise<string> {
    return call<string>("deposit_to_vault", { rawAmount });
  },
  async transferNative(to: string, amount: string): Promise<string> {
    return call<string>("transfer_native", { to, amount });
  },
  async transferUSDT(to: string, rawAmount: string): Promise<string> {
    return call<string>("transfer_usdt", { to, rawAmount });
  },
  async transferToken(tokenAddress: string, to: string, rawAmount: string): Promise<string> {
    return call<string>("transfer_token", { tokenAddress, to, rawAmount });
  },
  async syncDeposit(txHash: string, userAddress: string) {
    return tryCall("sync_deposit", { txHash, userAddress });
  },
};
