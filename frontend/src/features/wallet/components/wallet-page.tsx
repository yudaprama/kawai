import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/shared/icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { useI18n } from "@/hooks/use-i18n";
import { tauriBlockchainAdapter } from "../lib/blockchain-adapter";
import type { NetworkInfo, WalletTransaction } from "../lib/types";
import { DEFAULT_CHAIN_ID } from "../lib/types";
import { useBalances } from "../hooks/use-balances";
import { useNetwork } from "../hooks/use-network";
import { useWallet } from "../hooks/use-wallet";
import { QRCodeSVG } from "qrcode.react";
import { CopyButton } from "./copy-button";
import { HomeContent } from "./home-content";
import { SendForm } from "./send-form";
import { SmartDepositForm } from "./smart-deposit-form";

type ModalType = "send" | "receive" | "swap" | "deposit" | "addAccount" | "createWallet" | "addToken" | null;

/** Wallet modal that refuses dismissal (outside-click / Esc) while a
 *  transaction is in flight (`locked`) — a dropped dialog mid-broadcast
 *  would hide the pending state from the user. */
function LockedDialog({
  open,
  locked,
  title,
  onClose,
  children,
}: {
  open: boolean;
  locked: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !locked) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => locked && e.preventDefault()}
        onInteractOutside={(e) => locked && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function WalletPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { address, hasWallet, status, available, loading, create } = useWallet();
  const { currentNetwork, backendConfig } = useNetwork();
  const {
    onChainBalance,
    trackedBalance,
    nativeBalance,
    kawaiBalance,
    gasEstimate,
    currentBlock,
    nativePrice,
    kawaiPrice,
    loading: balancesLoading,
    reload: reloadBalances,
  } = useBalances(address, currentNetwork);

  const [active, setActive] = useState("home");
  const [modal, setModal] = useState<ModalType>(null);
  const [creating, setCreating] = useState(false);
  const [balanceVisible, setBalanceVisible] = useState(true);
  // Device-side tx history — monad_wallet_history (local JSON log, newest first).
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const records = await tauriBlockchainAdapter.getTransactionHistory();
      setTransactions(
        records.map((r) => ({
          id: r.txHash,
          txType: r.kind === "deposit" ? "Deposit" : "Send",
          amount: r.amount,
          symbol: r.symbol,
          txHash: r.txHash,
          createdAt: new Date(r.createdAtMs).toISOString(),
        })),
      );
    } catch (e: unknown) {
      // A failed read must not read as an empty wallet.
      setHistoryError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const [sending, setSending] = useState(false);

  // Map raw chain/RPC errors to plain-language messages; unknown errors pass
  // through raw (chain text is already user-meaningful).
  const describeTxError = (raw: string): string => {
    const m = raw.toLowerCase();
    if (m.includes("insufficient funds")) return t("wallet.errNoFeeFunds");
    if (m.includes("insufficient")) return t("wallet.errInsufficient");
    if (m.includes("reject") || m.includes("denied")) return t("wallet.errRejected");
    if (m.includes("revert")) return t("wallet.errReverted");
    if (m.includes("timeout") || m.includes("deadline")) return t("wallet.errTimeout");
    return raw;
  };

  // Background receipt polling (15 × 2s) — never blocks the UI; the modal
  // closes right after broadcast and the outcome arrives as a toast.
  const pollDepositReceipt = useCallback(
    async (txHash: string) => {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await tauriBlockchainAdapter.getTransactionReceipt(txHash);
          if (res) {
            if (res.success) toast.success(t("wallet.depositConfirmed"));
            else toast.error(t("wallet.depositFailed"));
            void reloadBalances();
            void loadHistory();
            return;
          }
        } catch {
          // transient RPC error — keep polling
        }
      }
      toast.info(t("wallet.depositPending"));
      void loadHistory();
    },
    [reloadBalances, loadHistory, t],
  );

  const handleDeposit = async (amount: string) => {
    setSending(true);
    try {
      // Rust does approve + deposit(uint256); returns the deposit tx hash
      const tx = await tauriBlockchainAdapter.depositToVault(amount);
      toast.success(t("wallet.depositSent", { hash: tx.txHash.slice(0, 10) }));
      setModal(null);
      void pollDepositReceipt(tx.txHash);
    } catch (e: unknown) {
      toast.error(describeTxError(e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (to: string, amount: string, assetType: string, customAddr?: string) => {
    setSending(true);
    try {
      let tx: { txHash: string };
      if (assetType === "native") {
        tx = await tauriBlockchainAdapter.transferNative(to, amount);
      } else if (assetType === "usdt") {
        tx = await tauriBlockchainAdapter.transferStablecoin(to, amount);
      } else if (assetType === "kawai") {
        const addr = backendConfig.contracts.kawai;
        if (!addr) throw new Error("KAWAI contract unavailable");
        tx = await tauriBlockchainAdapter.transferToken(addr, to, amount, 18);
      } else if (customAddr) {
        const info = await tauriBlockchainAdapter.getTokenInfo(customAddr, currentNetwork?.id ?? 143);
        if (!info) throw new Error("Token not found — check the contract address");
        tx = await tauriBlockchainAdapter.transferToken(customAddr, to, amount, info.decimals);
      } else {
        throw new Error("Unsupported asset");
      }
      toast.success(t("wallet.sentToast", { hash: tx.txHash.slice(0, 10) }));
      void reloadBalances();
      void loadHistory();
      setModal(null);
    } catch (e: unknown) {
      toast.error(describeTxError(e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  };

  // Not connected state — create a device wallet
  if (!hasWallet) {
    return (
      <AssetShell title={t("wallet.title")} subtitle={currentNetwork?.name ?? "Monad Testnet"} onBack={onBack}>
        <div className="mx-auto w-full max-w-lg space-y-6 py-8">
          <div className="text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
              <Icon name="wallet" className="size-6" />
            </div>
            <h3 className="mt-3 font-semibold">{available ? t("wallet.noWallet") : t("wallet.unavailableTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {available ? t("wallet.createHotWalletDesc") : t("wallet.unavailableDesc")}
            </p>
          </div>
          {available && (
            <Button
              className="w-full"
              disabled={creating || loading}
              onClick={async () => {
                setCreating(true);
                try {
                  await create();
                } finally {
                  setCreating(false);
                }
              }}
            >
              {loading ? t("wallet.checking") : creating ? t("wallet.creating") : t("wallet.createWallet")}
            </Button>
          )}
        </div>
      </AssetShell>
    );
  }

  return (
    <AssetShell
      title={t("wallet.title")}
      subtitle={
        address ? `${address.slice(0, 6)}...${address.slice(-4)} · ${currentNetwork?.name ?? ""}` : currentNetwork?.name
      }
      onBack={onBack}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <Tabs value={active} onValueChange={setActive}>
          <TabsList>
            <TabsTrigger value="home">{t("wallet.home")}</TabsTrigger>
            <TabsTrigger value="rewards">{t("wallet.rewards")}</TabsTrigger>
            <TabsTrigger value="settings">{t("common.settings")}</TabsTrigger>
          </TabsList>

          <TabsContent value="home" className="mt-4">
            <HomeContent
              address={address}
              onChainBalance={onChainBalance}
              trackedBalance={trackedBalance}
              nativeBalance={nativeBalance}
              kawaiBalance={kawaiBalance}
              nativePrice={nativePrice}
              kawaiPrice={kawaiPrice}
              balanceVisible={balanceVisible}
              setBalanceVisible={setBalanceVisible}
              setModalType={setModal}
              transactions={transactions}
              historyError={historyError}
              onRetryHistory={() => void loadHistory()}
              currentNetwork={currentNetwork}
              gasEstimate={gasEstimate}
              currentBlock={currentBlock}
              balancesLoading={balancesLoading}
            />
          </TabsContent>

          <TabsContent value="rewards" className="mt-4">
            <Card>
              <CardContent className="pt-6 text-center text-sm text-muted-foreground">
                {t("wallet.rewardsComingSoon")}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t("wallet.address")}</span>
                  <span className="font-mono text-xs flex items-center gap-2">
                    {address} <CopyButton text={address} />
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t("wallet.network")}</span>
                  <span className="text-sm">
                    {currentNetwork?.name} ({currentNetwork?.id})
                  </span>
                </div>
                {status && <div className="text-xs text-muted-foreground">{t("wallet.walletAddressActive")}</div>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Modals — locked (no outside-click / Esc) while a tx is in flight */}
      <LockedDialog
        open={modal === "deposit"}
        locked={sending}
        title={t("wallet.smartDeposit")}
        onClose={() => setModal(null)}
      >
        <SmartDepositForm
          onDeposit={handleDeposit}
          loading={sending}
          currentNetwork={currentNetwork}
          gasEstimate={gasEstimate}
          nativeBalance={nativeBalance}
        />
      </LockedDialog>
      <LockedDialog
        open={modal === "send"}
        locked={sending}
        title={t("wallet.sendAssets")}
        onClose={() => setModal(null)}
      >
        <SendForm onSend={handleSend} loading={sending} currentNetwork={currentNetwork} />
      </LockedDialog>
      <Dialog open={modal === "receive"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("wallet.receive")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="rounded-xl bg-card p-3 border">
              <QRCodeSVG value={address} size={200} marginSize={0} />
            </div>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span>
                {address.slice(0, 10)}...{address.slice(-10)}
              </span>
              <CopyButton text={address} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("wallet.receiveOnlyOn", {
                symbol: currentNetwork?.stablecoinSymbol ?? "",
                network: currentNetwork?.name ?? "",
              })}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "swap"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <div className="flex flex-col items-center gap-3 py-8">
            <Icon name="repeat-2" className="size-10 text-muted-foreground" />
            <p className="font-semibold">{t("wallet.comingSoon")}</p>
            <p className="text-sm text-muted-foreground">{t("wallet.tokenSwappingNext")}</p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "addToken"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("wallet.addToken")}</DialogTitle>
          </DialogHeader>
          <AddTokenInline currentNetwork={currentNetwork} onClose={() => setModal(null)} />
        </DialogContent>
      </Dialog>
    </AssetShell>
  );
}

function AddTokenInline({ currentNetwork, onClose }: { currentNetwork: NetworkInfo | null; onClose: () => void }) {
  const { t } = useI18n();
  const [addr, setAddr] = useState("");
  const [loading, setLoading] = useState(false);
  const onAdd = async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return toast.error(t("wallet.invalidAddress"));
    setLoading(true);
    try {
      const info = await tauriBlockchainAdapter.getTokenInfo(addr, currentNetwork?.id ?? DEFAULT_CHAIN_ID);
      if (!info) throw new Error(t("wallet.tokenNotFound"));
      toast.success(t("wallet.tokenFound", { symbol: info.symbol, decimals: info.decimals }));
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>{t("wallet.tokenContractAddress")}</Label>
        <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x..." />
      </div>
      <Button className="w-full" onClick={onAdd} disabled={loading}>
        {loading ? "Checking..." : "Add Token"}
      </Button>
    </div>
  );
}
