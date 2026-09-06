import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import type { WalletInfo, WalletStatus } from "../lib/types";

export function useWallet() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await tauriWalletAdapter.getStatus();
      setStatus(s);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (pw: string, mnemonic: string, desc?: string) => {
      const addr = await tauriWalletAdapter.createWallet(pw, mnemonic, desc);
      await refresh();
      return addr;
    },
    [refresh],
  );

  const remove = useCallback(
    async (addr: string) => {
      await tauriWalletAdapter.deleteWallet(addr);
      await refresh();
    },
    [refresh],
  );

  return {
    status,
    wallets: status?.wallets ?? ([] as WalletInfo[]),
    address: status?.address ?? "",
    hasWallet: !!status?.hasWallet,
    isLocked: !!status?.isLocked,
    loading,
    refresh,
    create,
    remove,
  };
}
