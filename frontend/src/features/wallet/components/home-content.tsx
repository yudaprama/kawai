import { useState } from "react";
import { Icon } from "@/components/shared/icon";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";
import type { GasEstimate, NetworkInfo, UserBalanceInfo } from "../lib/types";
import { getFaucetUrl, safeParseFloat } from "../lib/utils";
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
  transactions: { id: string; txType: string; amount: string; symbol?: string; txHash: string; createdAt: string }[];
  /** Failed history read — renders a retry row instead of the empty state. */
  historyError: string | null;
  onRetryHistory: () => void;
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
  historyError,
  onRetryHistory,
  currentNetwork,
  gasEstimate,
  currentBlock,
  balancesLoading,
}: Props) {
  const { t, fmtNumber, fmtRelative } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const usdtValue = safeParseFloat(onChainBalance, 0);
  const nativeValue = safeParseFloat(nativeBalance, 0) * nativePrice;
  const kawaiValue = safeParseFloat(kawaiBalance, 0) * kawaiPrice;
  const total = usdtValue + nativeValue + kawaiValue;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-5">
      <Card className="relative overflow-hidden bg-card">
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
                {balanceVisible ? <Icon name="eye" className="size-4" /> : <Icon name="eye-off" className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{balanceVisible ? "Hide balance" : "Show balance"}</TooltipContent>
          </Tooltip>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                {t("wallet.totalPortfolioValue")}
              </p>
              <p className="mt-1 text-3xl font-bold">
                {balancesLoading ? (
                  <span className="text-muted-foreground text-lg">{t("common.loading")}</span>
                ) : balanceVisible ? (
                  `$${fmtNumber(total, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                ) : (
                  "••••••"
                )}
                <span className="ml-2 text-base font-medium text-muted-foreground">USD</span>
              </p>

              {currentNetwork && (
                <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Icon name="coins" className="size-3.5" /> {t("wallet.balance")}:{" "}
                    <span className="text-foreground font-medium">
                      {balanceVisible ? onChainBalance : "••••"} {currentNetwork.stablecoinSymbol}
                    </span>
                  </div>
                  {trackedBalance && (
                    <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-1.5">
                      <Badge variant="secondary" className="bg-success text-success-foreground">
                        {t("wallet.aiBalance")}
                      </Badge>
                      <span className="text-foreground">
                        {balanceVisible ? trackedBalance.usdt_balance : "•••"} {currentNetwork.stablecoinSymbol}
                      </span>
                      {trackedBalance.trial_claimed && (
                        <Badge className="bg-success text-success-foreground">{t("wallet.trial")}</Badge>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Icon name="gift" className="size-3.5" /> {t("wallet.kawaiRewards")}{" "}
                    <span className="text-foreground font-medium">{balanceVisible ? kawaiBalance : "•••"} KAWAI</span>
                    {trackedBalance?.has_referrer && (
                      <Badge variant="secondary" className="bg-purple-600/10 text-purple-600 border-purple-600/30">
                        {t("wallet.referralBadge")}
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
                      <Icon name="fuel" className="size-3" /> {gasEstimate.maxGasPriceGwei.toFixed(1)} Gwei
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Max Tip {gasEstimate.maxTipGwei.toFixed(2)} Gwei</TooltipContent>
                </Tooltip>
              )}
              {currentBlock > 0 && <div>Block #{fmtNumber(currentBlock)}</div>}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-center gap-3">
        {[
          { label: t("wallet.depositToVault"), icon: "plus", action: () => setModalType("deposit") },
          { label: t("wallet.send"), icon: "send", action: () => setModalType("send") },
          { label: t("wallet.receive"), icon: "arrow-down-to-line", action: () => setModalType("receive") },
          { label: t("wallet.swap"), icon: "repeat-2", action: () => toast.info(t("wallet.comingSoon")) },
        ].map((a) => (
          <button
            type="button"
            key={a.label}
            onClick={a.action}
            className="flex flex-col items-center gap-2 rounded-xl border bg-card p-4 hover:bg-accent transition"
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon name={a.icon} className="size-6" />
            </span>
            <span className="text-xs font-semibold">{a.label}</span>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Icon name="coins" className="size-4" /> Tokens
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setModalType("addToken")}>
            <Icon name="plus" className="size-4" /> {t("wallet.addToken")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {currentNetwork && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <NetworkIcon name={currentNetwork.icon || "ethereum"} size={32} />
                <div>
                  <div className="font-semibold text-sm">{currentNetwork.nativeTokenSymbol}</div>
                  <div className="text-xs text-muted-foreground">{t("wallet.nativeToken")}</div>
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
              <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-rose-500 text-white">
                <Icon name="gift" className="size-4" />
              </span>
              <div>
                <div className="font-semibold text-sm">KAWAI</div>
                <div className="text-xs text-muted-foreground">{t("wallet.kawaiToken")}</div>
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
            <Icon name="history" className="size-4" /> {t("wallet.txHistory")}
          </CardTitle>
          {transactions.length > 5 && (
            <Button variant="link" size="sm" onClick={() => setShowAll(true)}>
              {t("wallet.viewAll", { count: transactions.length })}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {historyError != null ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-destructive min-w-0 text-xs" role="alert">
                {t("wallet.txHistoryError", { error: historyError })}
              </p>
              <Button onClick={onRetryHistory} size="sm" variant="outline">
                {t("common.retry")}
              </Button>
            </div>
          ) : transactions.length ? (
            <div className="space-y-2">
              {transactions.slice(0, 5).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <Badge variant="secondary">{tx.txType}</Badge>
                  <span className="text-xs text-muted-foreground">{fmtRelative(new Date(tx.createdAt))}</span>
                  <span className="font-mono text-xs">
                    {tx.txHash ? `${tx.txHash.slice(0, 6)}...${tx.txHash.slice(-4)}` : "-"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t("wallet.noTransactions")}</p>
              {currentNetwork?.isTestnet && (
                <Button size="sm" onClick={() => window.open(getFaucetUrl(currentNetwork?.id), "_blank")}>
                  {t("wallet.faucetCta")}
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
              <Icon name="history" className="size-4" /> {t("wallet.txHistory")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-auto">
            {transactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <Badge>{tx.txType}</Badge>
                <span>
                  {tx.amount} {tx.symbol ?? currentNetwork?.stablecoinSymbol}
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
