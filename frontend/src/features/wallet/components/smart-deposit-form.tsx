import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NetworkInfo } from "../lib/types";

type Props = { onDeposit: (amount: string) => void; loading: boolean; currentNetwork: NetworkInfo | null };

export function SmartDepositForm({ onDeposit, loading, currentNetwork }: Props) {
  const [amount, setAmount] = useState("10");
  const sym = currentNetwork?.stablecoinShort || "USDT";
  const symLong = currentNetwork?.stablecoinSymbol || "USDT";
  const name = currentNetwork?.name || "Monad Mainnet";
  const id = currentNetwork?.id || 143;

  return (
    <div className="space-y-4">
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
          Learn how to bridge <ExternalLinkIcon className="ml-1 size-3" />
        </Button>
      </div>
      <div className="space-y-2">
        <Label>Amount ({sym})</Label>
        <div className="flex gap-2">
          <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" />
          <span className="flex items-center rounded-md border bg-muted px-3 text-sm">{sym}</span>
        </div>
      </div>
      <Button
        className="w-full"
        disabled={loading || !(parseFloat(amount) > 0)}
        onClick={() => onDeposit(amount.trim())}
      >
        {loading ? "Processing..." : "Confirm Deposit"}
      </Button>
    </div>
  );
}
