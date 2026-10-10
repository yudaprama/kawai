import { useCallback, useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { call, errText } from "@/lib/api";

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

  return (
    <div className="bg-muted/30 flex items-center justify-between rounded-md border p-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Risk guard</div>
        <p className="text-muted-foreground text-xs">
          Periksa posisi futures tiap 15 menit selama app terbuka — peringatan di log saat ada posisi tanpa stop-loss.
        </p>
      </div>
      <Switch
        checked={guard?.enabled ?? false}
        disabled={busy || guard === null}
        onCheckedChange={(v) => void toggle(v)}
      />
    </div>
  );
}

/** Futures trading consent state from `binance_trading_status`. */
interface FuturesTradingStatus {
  hasOwnKeys: boolean;
  consented: boolean;
}

/** The one switch that unlocks the WRITING futures tools (place reduce-only
 *  SL/TP, cancel protective order). Everything else stays read-only. The
 *  consent is bound to the CURRENT key pair — rotating the keys flips it
 *  back off and the next enable re-asks. Arming requires typing ENABLE, both
 *  in this UI and again server-side. */
function FuturesTradingConsent() {
  const [status, setStatus] = useState<FuturesTradingStatus | null>(null);
  const [arming, setArming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<FuturesTradingStatus>("binance_trading_status"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("binance_trading_disable");
      setStatus((s) => (s ? { ...s, consented: false } : s));
      setArming(false);
      setConfirmText("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("binance_trading_enable", { confirm: confirmText });
      setStatus((s) => (s ? { ...s, consented: true } : s));
      setArming(false);
      setConfirmText("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const consented = status?.consented ?? false;
  return (
    <div className="bg-muted/30 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Futures trading</div>
          <p className="text-muted-foreground text-xs">
            {consented
              ? "AKTIF — agent boleh memasang stop-loss / take-profit reduce-only, selalu dengan konfirmasi per order."
              : status?.hasOwnKeys
                ? "Izinkan agent memasang stop-loss / take-profit reduce-only di akun futures Anda (butuh API key dengan izin Enable Futures). Setiap order tetap minta konfirmasi."
                : "Tambahkan API key Anda sendiri (izin Enable Futures, IP-restricted) dulu."}
          </p>
        </div>
        <Switch
          checked={consented}
          disabled={busy || status === null || !status.hasOwnKeys}
          onCheckedChange={(v) => (v ? setArming(true) : void disable())}
        />
      </div>
      {arming && !consented && (
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none"
            placeholder="ketik ENABLE untuk mengaktifkan"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || confirmText.trim() !== "ENABLE"}
              onClick={() => void enable()}
              className="rounded-md bg-destructive px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Aktifkan
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setArming(false);
                setConfirmText("");
              }}
              className="text-muted-foreground rounded-md px-3 py-1 text-xs hover:underline"
            >
              Batal
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Binance credentials — the user's OWN read-only, IP-restricted keys, stored
 * in the LOCAL database only. Every signed Binance tool falls back to the
 * product's baked pair when absent; the Futures Risk Audit does not (it grades
 * the user's own portfolio, so it requires `source === "user"`).
 */
export const binanceCredential: CredentialProvider = {
  id: "binance",
  icon: "candlestick-chart",
  titleKey: "credentials.binance.title",
  subtitleKey: "credentials.binance.subtitle",
  guideKey: "credentials.binance.guide",
  statusOp: "binance_credentials_status",
  setOp: "binance_credentials_set",
  deleteOp: "binance_credentials_delete",
  fields: [
    { arg: "apiKey", labelKey: "credentials.apiKey", autoComplete: "off" },
    { arg: "apiSecret", labelKey: "credentials.apiSecret", autoComplete: "new-password" },
  ],
  extra: (
    <>
      <FuturesTradingConsent />
      <RiskGuardSetting />
    </>
  ),
};
