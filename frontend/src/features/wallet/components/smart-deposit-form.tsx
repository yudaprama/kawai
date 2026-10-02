import { useState } from "react";
import { Icon } from "@/components/shared/icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import type { GasEstimate, NetworkInfo } from "../lib/types";

type Props = {
  onDeposit: (amount: string) => void;
  loading: boolean;
  currentNetwork: NetworkInfo | null;
  gasEstimate: GasEstimate | null;
  nativeBalance: string;
};

const AMOUNT_RE = /^\d+(\.\d+)?$/;
const QUICK_AMOUNTS = [10, 25, 50, 100];

export function SmartDepositForm({ onDeposit, loading, currentNetwork, gasEstimate, nativeBalance }: Props) {
  const { t } = useI18n();
  const [amount, setAmount] = useState("10");
  const [review, setReview] = useState(false);
  const sym = currentNetwork?.stablecoinShort || "USDT";
  const symLong = currentNetwork?.stablecoinSymbol || "USDT";
  const name = currentNetwork?.name || "Monad Mainnet";
  const id = currentNetwork?.id || 143;

  const valid = AMOUNT_RE.test(amount.trim()) && parseFloat(amount) > 0;
  const needsGas = parseFloat(nativeBalance) <= 0;

  if (review) {
    return (
      <div className="space-y-4">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon name="plus" className="size-6" />
          </div>
          <p className="mt-2 font-semibold">{t("wallet.confirmDeposit")}</p>
        </div>
        <div className="space-y-2 rounded-xl border bg-muted/50 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("wallet.amount")}</span>
            <span className="font-semibold">
              {amount} {symLong}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("wallet.network")}</span>
            <span>
              {name} ({id})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("wallet.estGasPrice")}</span>
            <span>{gasEstimate ? `~${gasEstimate.maxGasPriceGwei} gwei (paid in MON)` : "—"}</span>
          </div>
        </div>
        {needsGas && <p className="text-xs text-warning">{t("wallet.noGasWarning")}</p>}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={loading} onClick={() => setReview(false)}>
            {t("common.back")}
          </Button>
          <Button className="flex-1" disabled={loading} onClick={() => onDeposit(amount.trim())}>
            {loading ? t("wallet.processing") : t("wallet.confirmDepositCta")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("wallet.depositIntro", { symbol: symLong, network: name })}</p>
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
        <p className="font-semibold">{t("wallet.depositWarningTitle", { symbol: symLong })}</p>
        <p className="text-muted-foreground mt-1">{t("wallet.depositWarningBody")}</p>
        <p className="text-xs text-muted-foreground mt-2">
          {t("wallet.network")}: <strong>{name}</strong> (Chain ID: {id})
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 mt-1"
          onClick={() => window.open("https://getkawai.com/docs/user-guide/deposit-from-exchange", "_blank")}
        >
          {t("wallet.bridgeGuide")} <Icon name="external-link" className="ml-1 size-3" />
        </Button>
      </div>
      <div className="space-y-2">
        <Label>{t("wallet.amountWithSymbol", { symbol: sym })}</Label>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          className="flex-1"
        />
        <div className="flex gap-2">
          {QUICK_AMOUNTS.map((v) => (
            <Button
              key={v}
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setAmount(String(v))}
            >
              {v}
            </Button>
          ))}
        </div>
      </div>
      <Button
        className="w-full"
        disabled={!valid}
        onClick={() => (valid ? setReview(true) : toast.error("Invalid amount"))}
      >
        Review Deposit
      </Button>
    </div>
  );
}
