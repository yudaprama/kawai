import type { BackendConfig, NetworkInfo } from "./types";

// Single hardcoded config — no backend round-trip. ACTIVE NETWORK: Monad
// Testnet (Round 8, 2026-01-24), safe for fund testing. Mainnet block kept
// below for the flip. Source of truth: NETWORKS.md at the repo root — keep
// this file and src-tauri/src/logic/monad_contracts.rs in sync.

export const MONAD_TESTNET_RPC_URL = "https://testnet-rpc.monad.xyz";
export const MONAD_MAINNET_RPC_URL = "https://rpc.monad.xyz";

export const TESTNET_CONTRACTS = {
  usdt: "0x3AE05118C5B75b1B0b860ec4b7Ec5095188D1CCc", // symbol: USDT, 6 decimals (verified live)
  kawai: "0x5eB56dB2203cfbebDa20ef4a7c11C559D4396C60", // 18 decimals (verified live)
  paymentVault: "0x57C13B0fC9B854779cae43469095eAF8cE434276",
  otcMarket: "0x9c4a679cE79BB3334D82EeBA3e80C034a0Ad9863",
  miningDistributor: "0xD2D1CAC75976a0438aF0Ab2bC0741cE86857953f",
  cashbackDistributor: "0x585FBD1dC3806bE0A5b047c1c4616DAF3eAe5114",
  referralDistributor: "0x081b6b3cb53bb0c220d6808d775ee7517d41e08a",
  usdtDistributor: "0x3C714F875809dD9444dA8D4711aeFC2ee6570733", // RevenueDistributorAddress
} as const;

// Inactive — promotion target.
export const MAINNET_CONTRACTS = {
  usdt: "0x754704bc059f8c67012fed69bc8a327a5aafb603", // symbol: USDC, 6 decimals (verified live)
  kawai: "0xBd95bDB3a6FE48CbC2dE3890B8e67Ef96Af65322", // 18 decimals (verified live)
  paymentVault: "0x8381DBC83DdfEc1Ee958BcBdCf5340b406cA9E64",
  otcMarket: "0x75d1A6CC51035D7E5Cbe88aEc6DCfd6ABEB22bfE",
  miningDistributor: "0x6326F97DAf97e51fc7480Df5A5D0DB08bCDed4c8",
  cashbackDistributor: "0x646A1724E7375eFDBd6Ed5073cBb50569c4C15A1",
  referralDistributor: "0x018942E0e4a645a92660547DF307a4869510EF56",
  usdtDistributor: "0x409A95D5c39d485697918a534C21E9ADDFb6edEc", // RevenueDistributorAddress
} as const;

export const CONTRACTS = TESTNET_CONTRACTS;

export const DEFAULT_NETWORK: NetworkInfo = {
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
};

export function getBackendNetworkConfig(): BackendConfig {
  return {
    environment: "testnet",
    network: {
      name: DEFAULT_NETWORK.name,
      chainId: DEFAULT_NETWORK.id,
      isTestnet: DEFAULT_NETWORK.isTestnet,
    },
    contracts: { ...CONTRACTS },
  };
}

export function getKawaiTokenAddress(cfg: BackendConfig | null, _networkId?: number): string {
  if (!cfg) return "";
  return cfg.contracts.kawai || "";
}

export function getStablecoinSymbol(cfg: BackendConfig | null): string {
  if (!cfg) return "USDT";
  return cfg.network.isTestnet ? "USDT" : "USDC";
}
