import { useCallback, useEffect, useState } from "react";
import { tauriBlockchainAdapter } from "../lib/blockchain-adapter";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import type { GasEstimate, NetworkInfo, UserBalanceInfo } from "../lib/types";

export function useBalances(address: string, currentNetwork: NetworkInfo | null) {
  const [onChainBalance, setOnChainBalance] = useState("0.00");
  const [trackedBalance, setTrackedBalance] = useState<UserBalanceInfo | null>(null);
  const [nativeBalance, setNativeBalance] = useState("0.00");
  const [kawaiBalance, setKawaiBalance] = useState("0.00");
  const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
  const [currentBlock, setCurrentBlock] = useState(0);
  const [nativePrice, setNativePrice] = useState(0);
  const [kawaiPrice, setKawaiPrice] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address || !currentNetwork) return;
    setLoading(true);
    try {
      const [vault, tracked, native, gas, block] = await Promise.all([
        tauriBlockchainAdapter.getVaultBalance().catch(() => "0.00"),
        tauriWalletAdapter.getUserBalanceInfo().catch(() => null),
        tauriBlockchainAdapter.getNativeBalance(address, currentNetwork.id).catch(() => null),
        tauriBlockchainAdapter.estimateGas(currentNetwork.id).catch(() => null),
        tauriBlockchainAdapter.getCurrentBlock(currentNetwork.id).catch(() => 0),
      ]);
      setOnChainBalance(vault);
      setTrackedBalance(tracked);
      if (native) setNativeBalance(native.formatted);
      if (gas) setGasEstimate(gas);
      setCurrentBlock(block);

      // token balances/prices — best effort
      const kawaiAddr = (currentNetwork as unknown as { kawai?: string })?.kawai || "";
      if (kawaiAddr) {
        const kb = await tauriBlockchainAdapter
          .getTokenBalance(kawaiAddr, address, currentNetwork.id)
          .catch(() => null);
        if (kb) setKawaiBalance(kb.formatted);
        const kp = await tauriBlockchainAdapter.getTokenPrice(kawaiAddr, currentNetwork.id).catch(() => 0);
        setKawaiPrice(kp);
      }
      const np = await tauriBlockchainAdapter
        .getTokenPrice("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", currentNetwork.id)
        .catch(() => 0);
      setNativePrice(np);
    } finally {
      setLoading(false);
    }
  }, [address, currentNetwork]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    onChainBalance,
    trackedBalance,
    nativeBalance,
    kawaiBalance,
    gasEstimate,
    currentBlock,
    nativePrice,
    kawaiPrice,
    loading,
    reload: load,
  };
}
