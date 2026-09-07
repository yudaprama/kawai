import { useState } from "react";
import {
  ArrowDownToLineIcon,
  CoinsIcon,
  EyeIcon,
  EyeOffIcon,
  FuelIcon,
  GiftIcon,
  HistoryIcon,
  PlusIcon,
  Repeat2Icon,
  SendIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GasEstimate, NetworkInfo, UserBalanceInfo } from "../lib/types";
import { formatRelativeTime, getFaucetUrl, safeParseFloat } from "../lib/utils";
import { NetworkIcon } from "./network-icon";
import { StablecoinIcon } from "./stablecoin-icon";

type Props = {
  address: string;
  onChainBalance: string;
  trackedBalance: UserBalanceInfo | null;
  nativeBalance: string;
  kawaiBalance: string;
  nativePrice: number;
  kawaiPrice: number;
  balanceVisible: boolean;
  setBalanceVisible: (v: boolean) => void;
  setModalType: (
    t: "send" | "receive" | "swap" | "deposit" | "addAccount" | "createWallet" | "addToken" | null,
  ) => void;
  transactions: { id: string; txType: string; amount: string; txHash: string; createdAt: string }[];
  currentNetwork: NetworkInfo | null;
  gasEstimate: GasEstimate | null;
  currentBlock: number;
  balancesLoading: boolean;
};

export function HomeContent({
  address: _address,
  onChainBalance,
  trackedBalance,
  nativeBalance,
  kawaiBalance,
  nativePrice,
  kawaiPrice,
  balanceVisible,
  setBalanceVisible,
  setModalType,
  transactions,
  currentNetwork,
  gasEstimate,
  currentBlock,
  balancesLoading,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const usdtValue = safeParseFloat(onChainBalance, 0);
  const nativeValue = safeParseFloat(nativeBalance, 0) * nativePrice;
  const kawaiValue = safeParseFloat(kawaiBalance, 0) * kawaiPrice;
  const total = usdtValue + nativeValue + kawaiValue;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5">
      <Card className="relative overflow-hidden">
        <CardContent className="pt-6">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-3 top-3 size-7"
                onClick={() => setBalanceVisible(!balanceVisible)}
                aria-label={balanceVisible ? "Hide" : "Show"}
              >
                {balanceVisible ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{balanceVisible ? "Hide balance" : "Show balance"}</TooltipContent>
          </Tooltip>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Total Portfolio Value</p>
              <p className="mt-1 text-3xl font-bold">
                {balancesLoading ? (
                  <span className="text-muted-foreground text-lg">Loading...</span>
                ) : balanceVisible ? (
                  `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                ) : (
                  "••••••"
                )}
                <span className="ml-2 text-base font-medium text-muted-foreground">USD</span>
              </p>

              {currentNetwork && (
                <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <CoinsIcon className="size-3.5" /> Wallet Balance:{" "}
                    <span className="text-foreground font-medium">
                      {balanceVisible ? onChainBalance : "••••"} {currentNetwork.stablecoinSymbol}
                    </span>
                  </div>
                  {trackedBalance && (
                    <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-1.5 dark:border-green-900 dark:bg-green-950/20">
                      <Badge variant="secondary" className="bg-green-600 text-white">
                        AI Balance
                      </Badge>
                      <span className="text-foreground">
                        {balanceVisible ? trackedBalance.usdt_balance : "•••"} {currentNetwork.stablecoinSymbol}
                      </span>
                      {trackedBalance.trial_claimed && <Badge className="bg-green-600">Trial ✓</Badge>}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <GiftIcon className="size-3.5" /> KAWAI Rewards:{" "}
                    <span className="text-foreground font-medium">{balanceVisible ? kawaiBalance : "•••"} KAWAI</span>
                    {trackedBalance?.has_referrer && (
                      <Badge variant="secondary" className="bg-purple-600 text-white">
                        +5% Referral
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="text-right text-xs text-muted-foreground space-y-1">
              {gasEstimate && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1">
                      <FuelIcon className="size-3" /> {gasEstimate.maxGasPriceGwei.toFixed(1)} Gwei
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Max Tip {gasEstimate.maxTipGwei.toFixed(2)} Gwei</TooltipContent>
                </Tooltip>
              )}
              {currentBlock > 0 && <div>Block #{currentBlock.toLocaleString()}</div>}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-center gap-3">
        {[
          { label: "Deposit", icon: PlusIcon, action: () => setModalType("deposit") },
          { label: "Send", icon: SendIcon, action: () => setModalType("send") },
          { label: "Receive", icon: ArrowDownToLineIcon, action: () => setModalType("receive") },
          { label: "Swap", icon: Repeat2Icon, action: () => toast.info("Coming soon") },
        ].map((a) => (
          <button
            type="button"
            key={a.label}
            onClick={a.action}
            className="flex flex-col items-center gap-2 rounded-xl border bg-card p-4 hover:bg-accent transition"
          >
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <a.icon className="size-6" />
            </span>
            <span className="text-xs font-semibold">{a.label}</span>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CoinsIcon className="size-4" /> Tokens
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setModalType("addToken")}>
            <PlusIcon className="size-4" /> Add Token
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {currentNetwork && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <NetworkIcon name={currentNetwork.icon || "ethereum"} size={32} />
                <div>
                  <div className="font-semibold text-sm">{currentNetwork.nativeTokenSymbol}</div>
                  <div className="text-xs text-muted-foreground">Native Token</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-bold text-sm">{balanceVisible ? nativeBalance : "••••"}</div>
                <div className="text-xs text-muted-foreground">
                  {balanceVisible && nativeValue > 0 ? `$${nativeValue.toFixed(2)}` : "—"}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <StablecoinIcon currentNetwork={currentNetwork} size={32} />
              <div>
                <div className="font-semibold text-sm">{currentNetwork?.stablecoinSymbol || "USDT"}</div>
                <div className="text-xs text-muted-foreground">{currentNetwork?.stablecoinName || "Tether USD"}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-bold text-sm">{balanceVisible ? onChainBalance : "••••"}</div>
              <div className="text-xs text-muted-foreground">
                {balanceVisible && usdtValue > 0 ? `$${usdtValue.toFixed(2)}` : "—"}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-pink-300 to-rose-400 text-white">
                <GiftIcon className="size-4" />
              </span>
              <div>
                <div className="font-semibold text-sm">KAWAI</div>
                <div className="text-xs text-muted-foreground">Kawai Token</div>
              </div>
            </div>
            <div className="text-right">
              <div className="font-bold text-sm">{balanceVisible ? kawaiBalance : "••••"}</div>
              <div className="text-xs text-muted-foreground">
                {balanceVisible && kawaiValue > 0 ? `$${kawaiValue.toFixed(2)}` : "—"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <HistoryIcon className="size-4" /> Recent Activity
          </CardTitle>
          {transactions.length > 5 && (
            <Button variant="link" size="sm" onClick={() => setShowAll(true)}>
              View All ({transactions.length})
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {transactions.length ? (
            <div className="space-y-2">
              {transactions.slice(0, 5).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <Badge variant="secondary">{tx.txType}</Badge>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(tx.createdAt)}</span>
                  <span className="font-mono text-xs">
                    {tx.txHash ? `${tx.txHash.slice(0, 6)}...${tx.txHash.slice(-4)}` : "-"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">No transactions yet</p>
              {currentNetwork?.isTestnet && (
                <Button size="sm" onClick={() => window.open(getFaucetUrl(currentNetwork?.id), "_blank")}>
                  Get Test Tokens (Faucet)
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAll} onOpenChange={setShowAll}>
        <DialogContent className="max-w-[700px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HistoryIcon className="size-4" /> Transaction History
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-auto">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <Badge>{tx.txType}</Badge>
                <span>
                  {tx.amount} {currentNetwork?.stablecoinSymbol}
                </span>
                <span className="font-mono text-xs">{tx.txHash.slice(0, 10)}...</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
