import { useCallback, useEffect, useState } from "react";
import { tauriBlockchainAdapter } from "../lib/blockchain-adapter";
import { CONTRACTS } from "../lib/network-config";
import type { GasEstimate, NetworkInfo } from "../lib/types";

export function useBalances(address: string, currentNetwork: NetworkInfo | null) {
  const [onChainBalance, setOnChainBalance] = useState("0.00");
  const [nativeBalance, setNativeBalance] = useState("0.00");
  const [kawaiBalance, setKawaiBalance] = useState("0.00");
  const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address || !currentNetwork) return;
    setLoading(true);
    try {
      const [vault, native, gas, block] = await Promise.all([
        tauriBlockchainAdapter.getVaultBalance(address).catch(() => "0.00"),
        tauriBlockchainAdapter.getNativeBalance(address, currentNetwork.id).catch(() => null),
        tauriBlockchainAdapter.estimateGas(currentNetwork.id).catch(() => null),
        tauriBlockchainAdapter.getCurrentBlock(currentNetwork.id).catch(() => 0),
      ]);
      setOnChainBalance(vault);
      if (native) setNativeBalance(native.formatted);
      if (gas) setGasEstimate(gas);
      setCurrentBlock(block);

      // token balances/prices — best effort
      const kawaiAddr = CONTRACTS.kawai;
      if (kawaiAddr) {
        const kb = await tauriBlockchainAdapter
          .getTokenBalance(kawaiAddr, address, currentNetwork.id)
          .catch(() => null);
        if (kb) setKawaiBalance(kb.formatted);
      }
    } finally {
      setLoading(false);
    }
  }, [address, currentNetwork]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    onChainBalance,
    trackedBalance: null as null,
    nativeBalance,
    kawaiBalance,
    gasEstimate,
    currentBlock,
    nativePrice: 0,
    kawaiPrice: 0,
    loading,
    reload: load,
  };
}
