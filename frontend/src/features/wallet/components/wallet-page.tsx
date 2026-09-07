import { useState } from "react";
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

type ModalType = "send" | "receive" | "swap" | "deposit" | "addAccount" | "createWallet" | "addToken" | null;

export function WalletPage({ onBack }: { onBack: () => void }) {
  const { address, hasWallet, status, available, loading, refresh, create } = useWallet();
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
  // mock tx history until backend provides real
  const [transactions] = useState<{ id: string; txType: string; amount: string; txHash: string; createdAt: string }[]>(
    [],
  );

  const [sending, setSending] = useState(false);

  const handleDeposit = async (amount: string) => {
    setSending(true);
    try {
      // Rust does approve + deposit(uint256); returns the deposit tx hash
      const tx = await tauriBlockchainAdapter.depositToVault(amount);
      toast.success(`Deposit sent ${tx.txHash.slice(0, 10)}...`);
      // poll for the receipt (15 × 2s, veridium parity)
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await tauriBlockchainAdapter.getTransactionReceipt(tx.txHash);
        if (res) {
          if (res.success) toast.success("Deposit confirmed on-chain");
          else toast.error("Deposit transaction failed on-chain");
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
      toast.success(`Sent — tx ${tx.txHash.slice(0, 10)}...`);
      void reloadBalances();
      setModal(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Not connected state — create a device wallet
  if (!hasWallet) {
    return (
      <AssetShell title="KAWAI Wallet" subtitle={currentNetwork?.name ?? "Monad Testnet"} onBack={onBack}>
        <div className="mx-auto w-full max-w-lg space-y-6 py-8">
          <div className="text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
              <WalletIcon className="size-6" />
            </div>
            <h3 className="mt-3 font-semibold">{available ? "No wallet found" : "Wallet unavailable in this build"}</h3>
            <p className="text-sm text-muted-foreground">
              {available
                ? "Create a hot wallet to manage your Monad assets."
                : "This build was compiled without the Monad feature. Rebuild with `--features monad`."}
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
              {loading ? "Checking..." : creating ? "Creating..." : "Create Wallet"}
            </Button>
          )}
        </div>
      </AssetShell>
    );
  }

  return (
    <AssetShell
      title="KAWAI Wallet"
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
                {status && <div className="text-xs text-muted-foreground">Wallet address active on this device.</div>}
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
          <p className="py-4 text-sm text-muted-foreground">
            kawai uses a single device-scoped hot wallet. Multiple accounts are not supported yet.
          </p>
        </DialogContent>
      </Dialog>
      <SetupForm
        open={modal === "createWallet"}
        onOpenChange={(o) => !o && setModal(null)}
        onSuccess={() => {
          setModal(null);
          void refresh();
        }}
      />
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
