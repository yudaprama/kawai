import { useCallback, useEffect, useState } from "react";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";

/** Status shape from `binance_credentials_status` — source + masked key
 *  preview. The secret NEVER crosses the backend boundary. */
interface BinanceCredentialStatus {
  source: "user" | "baked" | "none";
  keyPreview: string | null;
}

/** Risk-guard toggle state from `risk_guard_status`. */
interface RiskGuardStatus {
  enabled: boolean;
}

const SOURCE_LABEL: Record<BinanceCredentialStatus["source"], TranslationKey> = {
  user: "binanceApi.sourceUser",
  baked: "binanceApi.sourceBaked",
  none: "binanceApi.sourceNone",
};

const SOURCE_TONE: Record<BinanceCredentialStatus["source"], string> = {
  user: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  baked: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  none: "bg-muted text-muted-foreground",
};

/** Settings → Binance API: enter your OWN read-only, IP-restricted keys.
 *  Stored in the LOCAL database only (never synced, never sent anywhere);
 *  futures tools use them ahead of the built-in pair. */
export function BinanceApiPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<BinanceCredentialStatus | null>(null);
  const [guard, setGuard] = useState<RiskGuardStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<BinanceCredentialStatus>("binance_credentials_status"));
      setGuard(await call<RiskGuardStatus>("risk_guard_status"));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call("binance_credentials_set", { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
      setApiKey("");
      setApiSecret("");
      setNotice(t("binanceApi.saved"));
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await call("binance_credentials_delete");
      setNotice(t("binanceApi.removed"));
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = apiKey.trim().length > 0 && apiSecret.trim().length > 0 && !busy;

  const toggleGuard = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await call("risk_guard_set", { enabled });
      setGuard({ enabled });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AssetShell title={t("binanceApi.title")} subtitle={t("binanceApi.subtitle")} onBack={onBack}>
      <AssetPageHeader title={t("binanceApi.title")} subtitle={t("binanceApi.subtitle")} />
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            {status === null ? (
              <Spinner className="size-4" />
            ) : (
              <Badge className={SOURCE_TONE[status.source]} variant="secondary">
                {t(SOURCE_LABEL[status.source])}
              </Badge>
            )}
            {status?.keyPreview && <span className="font-mono text-xs text-muted-foreground">{status.keyPreview}</span>}
          </div>

          <p className="text-muted-foreground text-xs leading-relaxed">{t("binanceApi.guide")}</p>

          <div className="space-y-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={t("binanceApi.apiKey")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={t("binanceApi.apiSecret")}
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </div>

          {error && <p className="text-destructive text-xs">{error}</p>}
          {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Risk guard</div>
              <p className="text-muted-foreground text-xs">
                Periksa posisi futures tiap 15 menit selama app terbuka — peringatan di log saat ada posisi tanpa
                stop-loss.
              </p>
            </div>
            <Switch checked={guard?.enabled ?? false} disabled={busy} onCheckedChange={(v) => void toggleGuard(v)} />
          </div>

          <div className="flex gap-2">
            <Button size="sm" disabled={!canSave} onClick={() => void save()}>
              {busy ? <Spinner className="size-4" /> : t("binanceApi.save")}
            </Button>
            {status?.source === "user" && (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
                {t("binanceApi.remove")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </AssetShell>
  );
}
