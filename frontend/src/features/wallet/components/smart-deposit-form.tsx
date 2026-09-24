import { useState } from "react";
import { Icon } from "@/components/shared/icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
          <p className="mt-2 font-semibold">Confirm Deposit</p>
        </div>
        <div className="space-y-2 rounded-xl border bg-muted/50 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-semibold">
              {amount} {symLong}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Network</span>
            <span>
              {name} ({id})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Est. gas price</span>
            <span>{gasEstimate ? `~${gasEstimate.maxGasPriceGwei} gwei (paid in MON)` : "—"}</span>
          </div>
        </div>
        {needsGas && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            This wallet has no MON — network fees are paid in MON, so the deposit will fail without it.
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={loading} onClick={() => setReview(false)}>
            Back
          </Button>
          <Button className="flex-1" disabled={loading} onClick={() => onDeposit(amount.trim())}>
            {loading ? "Processing..." : "Confirm & Deposit"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Deposit {symLong} into your kawai balance on the {name} network.
      </p>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
        <p className="font-semibold">Only deposit {symLong} on Monad Network!</p>
        <p className="text-muted-foreground mt-1">Bridge from other networks first if needed.</p>
        <p className="text-xs text-muted-foreground mt-2">
          Network: <strong>{name}</strong> (Chain ID: {id})
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 mt-1"
          onClick={() => window.open("https://getkawai.com/docs/user-guide/deposit-from-exchange", "_blank")}
        >
          Learn how to bridge <Icon name="external-link" className="ml-1 size-3" />
        </Button>
      </div>
      <div className="space-y-2">
        <Label>Amount ({sym})</Label>
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
