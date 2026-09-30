import { useState } from "react";
import { Icon } from "@/components/shared/icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import type { NetworkInfo } from "../lib/types";

const ADDR_OK = /^0x[a-fA-F0-9]{40}$/;
// decimal string validation — the amount stays a string all the way to
// Rust, where parse_units does the integer math
const AMOUNT_OK = /^\d*(\.\d+)?$/;
const TO_ERR = "Enter a valid recipient address: 0x followed by 40 hex characters.";
const AMOUNT_ERR = "Enter an amount greater than zero.";
const TOKEN_ERR = "Enter a valid token contract address.";

type Props = {
  // wallet-page's handleSend is async (Promise<void>); await it so this form
  // can hold the confirm view until the send settles.
  onSend: (to: string, amount: string, asset: string, customAddr?: string) => void | Promise<void>;
  loading: boolean;
  currentNetwork?: NetworkInfo | null;
};

export function SendForm({ onSend, loading, currentNetwork }: Props) {
  const { t } = useI18n();
  const [asset, setAsset] = useState("usdt");
  const [customAddr, setCustomAddr] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState<null | { to: string; amount: string; asset: string; customAddr?: string }>(
    null,
  );
  /** Per-field inline errors — set on blur, cleared while editing. */
  const [toErr, setToErr] = useState<string | null>(null);
  const [amountErr, setAmountErr] = useState<string | null>(null);
  /** Local in-flight guard for Confirm & Send (works even if onSend is void). */
  const [sendingLocal, setSendingLocal] = useState(false);

  const labelFor = (a: string) => {
    if (a === "native") return currentNetwork?.nativeTokenSymbol || "ETH";
    if (a === "usdt") return currentNetwork?.stablecoinSymbol || "USDT";
    if (a === "kawai") return "KAWAI";
    return a.toUpperCase();
  };

  const toOk = ADDR_OK.test(to);
  const amountOk = AMOUNT_OK.test(amount.trim()) && !!parseFloat(amount);
  const customOk = asset !== "custom" || ADDR_OK.test(customAddr);
  /** Honest-disabled Review button: the reason stays visible inline. */
  const reviewDisabled = !toOk || !amountOk || !customOk;
  const reviewReason = !toOk ? TO_ERR : !amountOk ? AMOUNT_ERR : !customOk ? TOKEN_ERR : null;

  const onReview = () => {
    if (!toOk) {
      setToErr(TO_ERR);
      return toast.error("Invalid recipient address");
    }
    if (!amountOk) {
      setAmountErr(AMOUNT_ERR);
      return toast.error("Invalid amount");
    }
    if (!customOk) return toast.error("Invalid token address");
    setConfirm({ to, amount: amount.trim(), asset, customAddr: asset === "custom" ? customAddr : undefined });
  };

  const onConfirm = async () => {
    if (confirm == null || sendingLocal) return;
    const snapshot = confirm;
    setSendingLocal(true);
    try {
      // Await the send so the summary (and the disabled "Sending..." state)
      // stays up until it settles. The view is deliberately NOT cleared here:
      // wallet-page's handleSend resolves even on failure — it catches and
      // toasts — while a successful send closes the dialog itself via
      // setModal(null), unmounting this view. So the summary disappears only
      // on success (or an explicit Cancel) instead of vanishing and leaving
      // the failure toast orphaned on the bare form.
      await onSend(snapshot.to, snapshot.amount, snapshot.asset, snapshot.customAddr);
    } catch {
      // Rejection also means a failed send — the parent reports it, and the
      // summary stays so the user can retry or cancel.
    } finally {
      setSendingLocal(false);
    }
  };

  if (confirm) {
    return (
      <div className="space-y-4">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon name="send" className="size-6" />
          </div>
          <p className="mt-2 font-semibold">{t("wallet.confirmTransaction")}</p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4 text-sm space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">To</span>
            <span className="font-mono text-xs">
              {confirm.to.slice(0, 10)}...{confirm.to.slice(-8)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("wallet.amount")}</span>
            <span className="font-semibold">
              {confirm.amount} {labelFor(confirm.asset)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("wallet.network")}</span>
            <span>{currentNetwork?.name ?? "Monad"}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={loading || sendingLocal}
            onClick={() => setConfirm(null)}
          >
            {t("common.cancel")}
          </Button>
          <Button className="flex-1" disabled={loading || sendingLocal} onClick={() => void onConfirm()}>
            {loading || sendingLocal ? "Sending..." : "Confirm & Send"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t("wallet.asset")}</Label>
        <Select value={asset} onValueChange={setAsset}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="native">Native ({currentNetwork?.nativeTokenSymbol || "ETH"})</SelectItem>
            <SelectItem value="usdt">{currentNetwork?.stablecoinSymbol === "USDC" ? "USDC" : "USDT"}</SelectItem>
            <SelectItem value="kawai">KAWAI</SelectItem>
            <SelectItem value="custom">{t("wallet.customToken")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {asset === "custom" && (
        <div className="space-y-2">
          <Label>{t("wallet.tokenContractAddress")}</Label>
          <Input placeholder="0x..." value={customAddr} onChange={(e) => setCustomAddr(e.target.value)} />
        </div>
      )}
      <div className="space-y-2">
        <Label>{t("wallet.recipientAddress")}</Label>
        <Input
          placeholder="0x..."
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            if (toErr) setToErr(null);
          }}
          onBlur={() => setToErr(to.length > 0 && !ADDR_OK.test(to) ? TO_ERR : null)}
        />
        {toErr && <p className="text-destructive text-xs">{toErr}</p>}
      </div>
      <div className="space-y-2">
        <Label>Amount</Label>
        <Input
          type="number"
          min={0}
          step="0.000001"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            if (amountErr) setAmountErr(null);
          }}
          onBlur={() =>
            setAmountErr(
              amount.trim().length > 0 && !(AMOUNT_OK.test(amount.trim()) && !!parseFloat(amount)) ? AMOUNT_ERR : null,
            )
          }
        />
        {amountErr && <p className="text-destructive text-xs">{amountErr}</p>}
      </div>
      <Button className="w-full" disabled={reviewDisabled} onClick={onReview}>
        Review Transaction
      </Button>
      {reviewDisabled && <p className="text-destructive text-xs">{reviewReason}</p>}
    </div>
  );
}
