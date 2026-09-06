import { useCallback, useState } from "react";
import { Repeat2Icon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { tauriBlockchainAdapter } from "../lib/blockchain-adapter";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import type { NetworkInfo } from "../lib/types";
import { DEFAULT_CHAIN_ID } from "../lib/types";
import { useBalances } from "../hooks/use-balances";
import { useNetwork } from "../hooks/use-network";
import { useWallet } from "../hooks/use-wallet";
import { CopyButton } from "./copy-button";
import { HomeContent } from "./home-content";
import { SendForm } from "./send-form";
import { SetupForm } from "./setup-form";
import { SmartDepositForm } from "./smart-deposit-form";

type ModalType =
  | "send"
  | "receive"
  | "swap"
  | "deposit"
  | "addAccount"
  | "createWallet"
  | "importWallet"
  | "addToken"
  | null;

export function WalletPage({ onBack }: { onBack: () => void }) {
  const { address, hasWallet, status, refresh } = useWallet();
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
  const [sending, setSending] = useState(false);
  const [_pendingSwitch] = useState<string | null>(null);
  const [balanceVisible, setBalanceVisible] = useState(true);
  // mock tx history until backend provides real
  const [transactions] = useState<{ id: string; txType: string; amount: string; txHash: string; createdAt: string }[]>(
    [],
  );

  const getKawaiAddr = useCallback(
    (_nid?: number) => {
      if (!backendConfig) return "";
      return backendConfig.contracts.kawai || "";
    },
    [backendConfig],
  );

  const handleDeposit = async (amount: number) => {
    setSending(true);
    try {
      const raw = Math.floor(amount * 1_000_000).toString();
      const txHash = await tauriBlockchainAdapter.depositToVault(raw);
      toast.success(`Deposit sent ${txHash.slice(0, 10)}...`);
      // poll sync
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const addr = await tauriWalletAdapter.getCurrentAddress();
        const res = await tauriBlockchainAdapter.syncDeposit(txHash, addr);
        if (res?.success) {
          toast.success(
            `Synced! ${res.newBalance ? (parseFloat(res.newBalance) / 1_000_000).toFixed(2) : ""} ${currentNetwork?.stablecoinSymbol}`,
          );
          break;
        }
      }
      void reloadBalances();
      setModal(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (to: string, amount: number, assetType: string, customAddr?: string) => {
    setSending(true);
    try {
      let tx = "";
      if (assetType === "native") tx = await tauriBlockchainAdapter.transferNative(to, amount.toString());
      else if (assetType === "usdt")
        tx = await tauriBlockchainAdapter.transferUSDT(to, Math.floor(amount * 1_000_000).toString());
      else if (assetType === "kawai") {
        const addr = currentNetwork ? getKawaiAddr(currentNetwork.id) : backendConfig?.contracts.kawai || "";
        if (!addr) throw new Error("KAWAI contract unavailable");
        const raw = (
          BigInt(Math.floor(amount)) * BigInt(10 ** 18) +
          BigInt(Math.round((amount % 1) * 1e18))
        ).toString();
        tx = await tauriBlockchainAdapter.transferToken(addr, to, raw);
      } else if (customAddr) {
        const nid = currentNetwork?.id || DEFAULT_CHAIN_ID;
        const info = await tauriBlockchainAdapter.getTokenInfo(customAddr, nid);
        const dec = info?.decimals ?? 18;
        const raw = (
          BigInt(Math.floor(amount)) * BigInt(10 ** dec) +
          BigInt(Math.round((amount % 1) * 10 ** dec))
        ).toString();
        tx = await tauriBlockchainAdapter.transferToken(customAddr, to, raw);
      }
      toast.success(`Sent ${tx.slice(0, 10)}...`);
      void reloadBalances();
      setModal(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Not connected state — show create/import
  if (!hasWallet) {
    return (
      <AssetShell title="Wallet" subtitle={currentNetwork?.name ?? "Monad Testnet"} onBack={onBack}>
        <div className="mx-auto w-full max-w-lg space-y-6 py-8">
          <div className="text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
              <WalletIcon className="size-6" />
            </div>
            <h3 className="mt-3 font-semibold">No wallet found</h3>
            <p className="text-sm text-muted-foreground">
              Create or import a wallet to manage your Monad assets. Same contracts as veridium.
            </p>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setModal("createWallet")}>
              Create Wallet
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => setModal("importWallet")}>
              Import
            </Button>
          </div>
          <Dialog
            open={modal === "createWallet" || modal === "importWallet"}
            onOpenChange={(o) => !o && setModal(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{modal === "createWallet" ? "Create Wallet" : "Import Wallet"}</DialogTitle>
              </DialogHeader>
              <SetupForm
                type={modal === "createWallet" ? "create" : "import"}
                onSuccess={() => {
                  setModal(null);
                  void refresh();
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </AssetShell>
    );
  }

  return (
    <AssetShell
      title="Wallet"
      subtitle={
        address ? `${address.slice(0, 6)}...${address.slice(-4)} · ${currentNetwork?.name ?? ""}` : currentNetwork?.name
      }
      onBack={onBack}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <Tabs value={active} onValueChange={setActive}>
          <TabsList>
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="rewards">Rewards</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
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
              currentNetwork={currentNetwork}
              gasEstimate={gasEstimate}
              currentBlock={currentBlock}
              balancesLoading={balancesLoading}
            />
          </TabsContent>

          <TabsContent value="rewards" className="mt-4">
            <Card>
              <CardContent className="pt-6 text-center text-sm text-muted-foreground">
                Rewards (mining / referral) reuse same contracts. Claiming will call the same distributors — hook up
                `get_claimable_rewards` when backend exposes it.
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Address</span>
                  <span className="font-mono text-xs flex items-center gap-2">
                    {address} <CopyButton text={address} />
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Network</span>
                  <span className="text-sm">
                    {currentNetwork?.name} ({currentNetwork?.id})
                  </span>
                </div>
                {status && (
                  <div className="text-xs text-muted-foreground">
                    Wallets: {status.wallets.length} · Locked: {String(status.isLocked)}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Modals */}
      <Dialog open={modal === "deposit"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Smart Deposit</DialogTitle>
          </DialogHeader>
          <SmartDepositForm onDeposit={handleDeposit} loading={sending} currentNetwork={currentNetwork} />
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "send"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Assets</DialogTitle>
          </DialogHeader>
          <SendForm onSend={handleSend} loading={sending} currentNetwork={currentNetwork} />
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "receive"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Receive</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="rounded-xl border bg-white p-3">
              {/* simple text fallback for QR — add qrcode.react later if needed */}
              <div className="font-mono text-xs break-all w-[200px] text-center">{address}</div>
            </div>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span>
                {address.slice(0, 10)}...{address.slice(-10)}
              </span>
              <CopyButton text={address} />
            </div>
            <p className="text-xs text-muted-foreground">
              Send only {currentNetwork?.stablecoinSymbol} on {currentNetwork?.name}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "swap"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <div className="flex flex-col items-center gap-3 py-8">
            <Repeat2Icon className="size-10 text-muted-foreground" />
            <p className="font-semibold">Coming Soon</p>
            <p className="text-sm text-muted-foreground">Token swapping next update.</p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "addAccount"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Account</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button onClick={() => setModal("createWallet")}>Create New Wallet</Button>
            <Button variant="outline" onClick={() => setModal("importWallet")}>
              Import Keystore
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "createWallet"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Wallet</DialogTitle>
          </DialogHeader>
          <SetupForm
            type="create"
            onSuccess={() => {
              setModal(null);
              void refresh();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "importWallet"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Wallet</DialogTitle>
          </DialogHeader>
          <SetupForm
            type="import"
            onSuccess={() => {
              setModal(null);
              void refresh();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "addToken"} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Token</DialogTitle>
          </DialogHeader>
          <AddTokenInline currentNetwork={currentNetwork} onClose={() => setModal(null)} />
        </DialogContent>
      </Dialog>
    </AssetShell>
  );
}

function AddTokenInline({ currentNetwork, onClose }: { currentNetwork: NetworkInfo | null; onClose: () => void }) {
  const [addr, setAddr] = useState("");
  const [loading, setLoading] = useState(false);
  const onAdd = async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return toast.error("Invalid address");
    setLoading(true);
    try {
      const info = await tauriBlockchainAdapter.getTokenInfo(addr, currentNetwork?.id ?? DEFAULT_CHAIN_ID);
      if (!info) throw new Error("Token not found");
      toast.success(`Found ${info.symbol} (${info.decimals} decimals)`);
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
        <Label>Token Contract Address</Label>
        <Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x..." />
      </div>
      <Button className="w-full" onClick={onAdd} disabled={loading}>
        {loading ? "Checking..." : "Add Token"}
      </Button>
    </div>
  );
}
