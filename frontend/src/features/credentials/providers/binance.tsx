import { useCallback, useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { call } from "@/lib/api";

import type { CredentialProvider } from "../types";

/** Risk-guard toggle state from `risk_guard_status`. */
interface RiskGuardStatus {
  enabled: boolean;
}

/** Binance-specific settings under the key form: the in-process futures
 *  risk guard (mirror sync + naked-position warnings, every 15 min while the
 *  app is open). Owns its own ops — the credential card never learns about it. */
function RiskGuardSetting() {
  const [guard, setGuard] = useState<RiskGuardStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGuard(await call<RiskGuardStatus>("risk_guard_status"));
    } catch {
      // Unreadable (feature off / op missing) — leave the toggle off and
      // unclaimed rather than showing a state we can't verify.
      setGuard(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await call("risk_guard_set", { enabled });
      setGuard({ enabled });
    } finally {
      setBusy(false);
    }
  };

  const { t } = useI18n();
  return (
    <div className="bg-muted/30 flex items-center justify-between rounded-md border p-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{t("credentials.binance.riskGuardTitle")}</div>
        <p className="text-muted-foreground text-xs">{t("credentials.binance.riskGuardDesc")}</p>
      </div>
      <Switch
        checked={guard?.enabled ?? false}
        disabled={busy || guard === null}
        onCheckedChange={(v) => void toggle(v)}
      />
    </div>
  );
}

/**
 * Binance credentials — the user's OWN keys, stored in the LOCAL database
 * only. Saving a pair automatically arms it for protective order placement
 * (consent follows the key); the audit still needs `source === "user"`.
 */
export const binanceCredential: CredentialProvider = {
  id: "binance",
  icon: "candlestick-chart",
  titleKey: "credentials.binance.title",
  subtitleKey: "credentials.binance.subtitle",
  guideDetailKey: "credentials.binance.guideDetail",
  guideKey: "credentials.binance.guide",
  statusOp: "binance_credentials_status",
  setOp: "binance_credentials_set",
  deleteOp: "binance_credentials_delete",
  fields: [
    { arg: "apiKey", labelKey: "credentials.apiKey", autoComplete: "off" },
    { arg: "apiSecret", labelKey: "credentials.apiSecret", autoComplete: "new-password" },
  ],
  extra: <RiskGuardSetting />,
};
