import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import type { WalletInfo, WalletStatus } from "../lib/types";

export function useWallet() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ok = await tauriWalletAdapter.isAvailable();
      setAvailable(ok);
      if (!ok) {
        setStatus(null);
        return;
      }
      setStatus(await tauriWalletAdapter.getStatus());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    const addr = await tauriWalletAdapter.createWallet();
    await refresh();
    return addr;
  }, [refresh]);

  const remove = useCallback(async () => {
    await tauriWalletAdapter.deleteWallet();
    await refresh();
  }, [refresh]);

  return {
    status,
    available,
    wallets: status?.wallets ?? ([] as WalletInfo[]),
    address: status?.address ?? "",
    hasWallet: !!status?.hasWallet,
    loading,
    refresh,
    create,
    remove,
  };
}
