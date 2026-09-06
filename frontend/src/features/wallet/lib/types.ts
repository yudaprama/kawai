// Wallet feature types — decoupled from veridium bindings.
// Keep shape compatible with veridium's NetworkInfo/BackendConfig but no Wails runtime.

export type NetworkEnvironment = {
  name: string;
  chainId: number;
  isTestnet: boolean;
};

export type ContractAddresses = {
  usdt: string;
  kawai: string;
  paymentVault: string;
  otcMarket: string;
  miningDistributor: string;
  cashbackDistributor: string;
  referralDistributor: string;
  usdtDistributor: string;
};

export type BackendConfig = {
  environment: "testnet" | "mainnet" | string;
  network: NetworkEnvironment;
  contracts: ContractAddresses;
};

export type NetworkInfo = {
  id: number;
  name: string;
  nativeTokenSymbol: string;
  nativeTokenDecimal: number;
  explorerURL: string;
  isTestnet: boolean;
  icon: string;
  stablecoinSymbol: string;
  stablecoinName: string;
  stablecoinShort: string;
};

export type GasEstimate = {
  maxGasPriceGwei: number;
  maxTipGwei: number;
  isDynamicFee: boolean;
};

export type BalanceInfo = {
  raw: string;
  formatted: string;
  decimals: number;
};

export type UserBalanceInfo = {
  address: string;
  usdt_balance: string;
  usdt_micro: string;
  kawai_balance: string;
  trial_claimed: boolean;
  referrer_address: string;
  has_referrer: boolean;
};

export type WalletInfo = {
  address: string;
  description: string;
  isActive: boolean;
};

export type WalletStatus = {
  hasWallet: boolean;
  isLocked: boolean;
  address: string;
  wallets: WalletInfo[];
};

export type WalletTransaction = {
  id: string;
  txType: string;
  amount: string;
  txHash: string;
  createdAt: string;
  status?: string;
};

export type TokenInfo = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
};

export const DEFAULT_CHAIN_ID = 10143; // Monad testnet — fallback
