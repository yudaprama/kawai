import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { tauriWalletAdapter } from "../lib/wallet-adapter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Device-wallet setup: the key lives in the OS keychain, scoped to this
// device. No password / mnemonic — there is nothing to import or export.
export function SetupForm({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setLoading(true);
    try {
      await tauriWalletAdapter.createWallet();
      toast.success(t("toasts.walletCreated"));
      onOpenChange(false);
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("wallet.createWallet")}</DialogTitle>
          <DialogDescription>
            A hot wallet will be generated and stored securely in this device's keychain. It cannot be recovered on
            another device.
          </DialogDescription>
        </DialogHeader>
        <Button className="w-full" onClick={handle} disabled={loading}>
          {loading ? "Creating..." : t("wallet.createWallet")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
