import { useCallback, useState } from "react";
import type { BackendConfig, NetworkInfo } from "../lib/types";
import { DEFAULT_NETWORK, getBackendNetworkConfig } from "../lib/network-config";

export function useNetwork() {
  const [backendConfig] = useState<BackendConfig>(() => getBackendNetworkConfig());
  const [currentNetwork, setCurrentNetwork] = useState<NetworkInfo>(DEFAULT_NETWORK);

  // Single hardcoded network — switching is a no-op until a second chain ships.
  const switchNetwork = useCallback(async (net: NetworkInfo) => {
    setCurrentNetwork(net);
  }, []);

  return { backendConfig, currentNetwork, loading: false, switchNetwork, reload: () => {} };
}
