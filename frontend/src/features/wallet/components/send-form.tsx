import { useState } from "react";
import { SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NetworkInfo } from "../lib/types";

type Props = {
  onSend: (to: string, amount: number, asset: string, customAddr?: string) => void;
  loading: boolean;
  currentNetwork?: NetworkInfo | null;
};

export function SendForm({ onSend, loading, currentNetwork }: Props) {
  const [asset, setAsset] = useState("usdt");
  const [customAddr, setCustomAddr] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState<null | { to: string; amount: number; asset: string; customAddr?: string }>(
    null,
  );

  const labelFor = (a: string) => {
    if (a === "native") return currentNetwork?.nativeTokenSymbol || "ETH";
    if (a === "usdt") return currentNetwork?.stablecoinSymbol || "USDT";
    if (a === "kawai") return "KAWAI";
    return a.toUpperCase();
  };

  const onReview = () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return toast.error("Invalid recipient address");
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) return toast.error("Invalid amount");
    if (asset === "custom" && !/^0x[a-fA-F0-9]{40}$/.test(customAddr)) return toast.error("Invalid token address");
    setConfirm({ to, amount: n, asset, customAddr: asset === "custom" ? customAddr : undefined });
  };

  if (confirm) {
    return (
      <div className="space-y-4">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <SendIcon className="size-6" />
          </div>
          <p className="mt-2 font-semibold">Confirm Transaction</p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4 text-sm space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">To</span>
            <span className="font-mono text-xs">
              {confirm.to.slice(0, 10)}...{confirm.to.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-semibold">
              {confirm.amount} {labelFor(confirm.asset)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Network</span>
            <span>{currentNetwork?.name ?? "Monad Testnet"}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={loading}
            onClick={() => {
              onSend(confirm.to, confirm.amount, confirm.asset, confirm.customAddr);
              setConfirm(null);
            }}
          >
            {loading ? "Sending..." : "Confirm & Send"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Asset</Label>
        <Select value={asset} onValueChange={setAsset}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="native">Native ({currentNetwork?.nativeTokenSymbol || "ETH"})</SelectItem>
            <SelectItem value="usdt">{currentNetwork?.stablecoinSymbol === "USDC" ? "USDC" : "USDT"}</SelectItem>
            <SelectItem value="kawai">KAWAI</SelectItem>
            <SelectItem value="custom">Custom Token</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {asset === "custom" && (
        <div className="space-y-2">
          <Label>Token Contract Address</Label>
          <Input placeholder="0x..." value={customAddr} onChange={(e) => setCustomAddr(e.target.value)} />
        </div>
      )}
      <div className="space-y-2">
        <Label>Recipient Address</Label>
        <Input placeholder="0x..." value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Amount</Label>
        <Input
          type="number"
          min={0}
          step="0.000001"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <Button className="w-full" onClick={onReview}>
        Review Transaction
      </Button>
    </div>
  );
}
