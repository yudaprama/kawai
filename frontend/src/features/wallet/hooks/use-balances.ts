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
  // Best-effort USD price of MON — 0 means "no dollar figure", never a guess.
  const [nativePrice, setNativePrice] = useState(0);

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

      // Best-effort MON/USD price (CoinGecko public endpoint, hardcoded id).
      // Failure leaves the price at 0 — HomeContent then shows no dollar figure.
      void fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd", {
        signal: AbortSignal.timeout(8000),
      })
        .then((r) => r.json())
        .then((d: { monad?: { usd?: number } }) => {
          if (typeof d?.monad?.usd === "number") setNativePrice(d.monad.usd);
        })
        .catch(() => {});

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
    nativePrice,
    kawaiPrice: 0, // no price feed for KAWAI — unit display only
    loading,
    reload: load,
  };
}
