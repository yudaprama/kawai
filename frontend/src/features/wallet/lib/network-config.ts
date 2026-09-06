import { call } from "@/lib/api";
import type { BackendConfig, NetworkInfo } from "./types";
import { DEFAULT_CHAIN_ID } from "./types";

// Veridium used ConfigService.GetConfig -> BackendConfig.
// Kawai tauri backend may expose `get_backend_config` or not yet. Provide fallback.

export async function getBackendNetworkConfig(): Promise<BackendConfig> {
  // Try canonical command first
  const candidates = ["get_backend_config", "get_config", "backend_config"];
  for (const cmd of candidates) {
    try {
      const cfg = await call<BackendConfig>(cmd);
      if (cfg?.network && cfg.contracts) return cfg;
    } catch {
      // try next
    }
  }
  // Fallback: build minimal config from local constants / chain status
  console.warn("[wallet] backend config unavailable, using fallback testnet");
  return {
    environment: "testnet",
    network: { name: "Monad Testnet", chainId: DEFAULT_CHAIN_ID, isTestnet: true },
    contracts: {
      usdt: "0x0000000000000000000000000000000000000000",
      kawai: "0x0000000000000000000000000000000000000000",
      paymentVault: "",
      otcMarket: "",
      miningDistributor: "",
      cashbackDistributor: "",
      referralDistributor: "",
      usdtDistributor: "",
    },
  };
}

export function getKawaiTokenAddress(cfg: BackendConfig | null, _networkId?: number): string {
  if (!cfg) return "";
  return cfg.contracts.kawai || "";
}

export function getStablecoinSymbol(cfg: BackendConfig | null): string {
  if (!cfg) return "USDT";
  return cfg.network.isTestnet ? "MockUSDT" : "USDC";
}

export async function fetchNetworkById(chainId: number): Promise<NetworkInfo | null> {
  try {
    return await call<NetworkInfo>("get_network_by_id", { chainId });
  } catch {
    return null;
  }
}
