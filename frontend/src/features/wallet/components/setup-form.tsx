import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import { CopyButton } from "./copy-button";

type Props = { type: "create" | "import"; onSuccess: () => void };

export function SetupForm({ type, onSuccess }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [description, setDescription] = useState("");
  const [step, setStep] = useState<"form" | "mnemonic">(type === "create" ? "mnemonic" : "form");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (type === "create" && step === "mnemonic") {
      tauriWalletAdapter
        .generateMnemonic()
        .then(setMnemonic)
        .catch(() =>
          setMnemonic("abandon ability able about above absent absorb abstract absurd abuse access accident"),
        );
    }
  }, [type, step]);

  const handle = async () => {
    if (password !== confirm) return toast.error("Passwords do not match");
    if (password.length < 8) return toast.error("Password must be >= 8 chars");
    if (!mnemonic.trim()) return toast.error("Mnemonic required");
    setLoading(true);
    try {
      await tauriWalletAdapter.createWallet(password, mnemonic.trim(), description);
      toast.success("Wallet created");
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  if (type === "create" && step === "mnemonic") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Save these 12 words securely — you will need them to recover the wallet.
        </p>
        <div className="rounded-lg border bg-muted p-4 text-center">
          <code className="text-sm font-bold break-words">{mnemonic || "Generating..."}</code>
          <div className="mt-2 flex justify-center">
            <CopyButton text={mnemonic} />
          </div>
        </div>
        <Button className="w-full" onClick={() => setStep("form")} disabled={!mnemonic}>
          I have written it down
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {type === "import" && (
        <div className="space-y-2">
          <Label>Mnemonic Phrase</Label>
          <Textarea
            rows={3}
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            placeholder="word1 word2 ..."
          />
        </div>
      )}
      <div className="space-y-2">
        <Label>Account Description</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Main account, Savings..."
        />
      </div>
      <div className="space-y-2">
        <Label>Lock Password</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
        />
      </div>
      <div className="space-y-2">
        <Label>Confirm Password</Label>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat password"
        />
      </div>
      <Button className="w-full" onClick={handle} disabled={loading}>
        {loading ? "Creating..." : type === "create" ? "Create Account" : "Import Account"}
      </Button>
    </div>
  );
}
