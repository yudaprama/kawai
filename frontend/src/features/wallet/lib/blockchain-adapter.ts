import { call } from "@/lib/api";
import type { BalanceInfo, GasEstimate, NetworkInfo, TokenInfo } from "./types";
import { CONTRACTS } from "./network-config";

// Thin adapter over the kawai Tauri Monad commands (see
// crates/integrations/monad). Single hardcoded Monad network; method
// signatures keep a networkId slot for forward compatibility but it is
// currently unused.

export interface BlockchainAdapter {
  getSupportedNetworks(): Promise<NetworkInfo[]>;
  getNativeBalance(address: string, networkId: number): Promise<BalanceInfo | null>;
  getTokenBalance(token: string, wallet: string, networkId: number): Promise<BalanceInfo | null>;
  getTokenInfo(token: string, networkId: number): Promise<TokenInfo | null>;
  estimateGas(networkId: number): Promise<GasEstimate | null>;
  getCurrentBlock(networkId: number): Promise<number>;
  getVaultBalance(address: string): Promise<string>;
  transferNative(to: string, amount: string): Promise<TxResult>;
  transferStablecoin(to: string, amount: string): Promise<TxResult>;
  transferToken(token: string, to: string, amount: string, decimals: number): Promise<TxResult>;
  depositToVault(amount: string): Promise<TxResult>;
  getTransactionReceipt(txHash: string): Promise<ReceiptInfo | null>;
}

export type TxResult = { txHash: string; from: string; to: string; amount: string; nonce: number };
export type ReceiptInfo = { txHash: string; success: boolean; blockNumber: number } | null;

async function tryCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await call<T>(cmd, args);
  } catch {
    return null;
  }
}

const HARDCODED_NETWORK: NetworkInfo = {
  id: 10143,
  name: "Monad Testnet",
  nativeTokenSymbol: "MON",
  nativeTokenDecimal: 18,
  explorerURL: "https://testnet.monadexplorer.com",
  isTestnet: true,
  icon: "monad",
  stablecoinSymbol: "USDC",
  stablecoinName: "USD Coin",
  stablecoinShort: "USDC",
};

export const tauriBlockchainAdapter: BlockchainAdapter = {
  async getSupportedNetworks(): Promise<NetworkInfo[]> {
    return [HARDCODED_NETWORK];
  },
  async getNativeBalance(address: string, _networkId: number): Promise<BalanceInfo | null> {
    const r = await tryCall<{ balanceWei: string; balanceMon: string }>("check_monad_balance", {
      walletAddress: address,
      rpcUrl: null,
    });
    if (!r) return null;
    return { raw: r.balanceWei, formatted: r.balanceMon, decimals: 18 };
  },
  async getTokenBalance(tokenAddress: string, walletAddress: string, _networkId: number): Promise<BalanceInfo | null> {
    const r = await tryCall<BalanceInfo>("get_token_balance", {
      tokenAddress,
      walletAddress,
      rpcUrl: null,
    });
    return r;
  },
  async getTokenInfo(tokenAddress: string, _networkId: number): Promise<TokenInfo | null> {
    return tryCall<TokenInfo>("get_token_info", { tokenAddress, rpcUrl: null });
  },
  async estimateGas(_networkId: number): Promise<GasEstimate | null> {
    const g = await tryCall<{ gasPriceGwei: string }>("estimate_gas", { rpcUrl: null });
    if (!g) return null;
    const price = parseFloat(g.gasPriceGwei);
    return Number.isNaN(price) ? null : { maxGasPriceGwei: price, maxTipGwei: 0, isDynamicFee: true };
  },
  async getCurrentBlock(_networkId: number): Promise<number> {
    const s = await tryCall<{ blockNumber: number }>("monad_chain_status", { rpcUrl: null });
    return s?.blockNumber ?? 0;
  },
  /** On-chain stablecoin (USDC, 6 decimals — verified live) balance of the wallet. */
  async getVaultBalance(address: string): Promise<string> {
    const b = await this.getTokenBalance(CONTRACTS.usdt, address, 10143);
    return b?.formatted ?? "0.00";
  },
  async transferNative(to: string, amount: string): Promise<TxResult> {
    return call<TxResult>("transfer_native", { to, amount });
  },
  async transferStablecoin(to: string, amount: string): Promise<TxResult> {
    return call<TxResult>("transfer_usdt", { to, amount });
  },
  async transferToken(token: string, to: string, amount: string, decimals: number): Promise<TxResult> {
    return call<TxResult>("transfer_token", { tokenAddress: token, to, amount, decimals });
  },
  async depositToVault(amount: string): Promise<TxResult> {
    return call<TxResult>("deposit_to_vault", { amount });
  },
  async getTransactionReceipt(txHash: string): Promise<ReceiptInfo | null> {
    return tryCall<ReceiptInfo>("get_transaction_receipt", { txHash });
  },
};
