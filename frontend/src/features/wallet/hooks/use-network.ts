import { useCallback, useEffect, useState } from "react";
import type { BackendConfig, NetworkInfo } from "../lib/types";
import { getBackendNetworkConfig } from "../lib/network-config";
import { tauriBlockchainAdapter } from "../lib/blockchain-adapter";

export function useNetwork() {
  const [backendConfig, setBackendConfig] = useState<BackendConfig | null>(null);
  const [currentNetwork, setCurrentNetwork] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getBackendNetworkConfig();
      setBackendConfig(cfg);
      const net = await tauriBlockchainAdapter.getNetworkByID(cfg.network.chainId);
      if (net) setCurrentNetwork(net);
    } catch (e) {
      console.error("[wallet] network load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchNetwork = useCallback(async (net: NetworkInfo) => {
    setCurrentNetwork(net);
  }, []);

  return { backendConfig, currentNetwork, loading, switchNetwork, reload: load };
}
