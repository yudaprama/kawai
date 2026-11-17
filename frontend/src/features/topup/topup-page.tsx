import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { cn } from "@/lib/utils";
import {
  call,
  errText,
  type TopupClaim,
  type TopupHistory,
  type TopupHistoryEntry,
  type TopupIapAvailable,
  type TopupPreview,
  type TopupStatusInfo,
  type TopupVoucherRedeem,
} from "@/lib/api";
import { QrisCard } from "@/features/topup/qris-card";
import { IapPanel } from "@/features/topup/iap-panel";
import { isLowTokenBalance, refreshTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";
import { useI18n } from "@/hooks/use-i18n";
import { formatNumber, type Locale, type TranslationKey } from "@/lib/i18n";

// ── Constants (source-hardcoded — repo rule: no new env) ────────────────────

/** First 5 minutes poll fast; after that the check backs off (manual refresh stays). */
const FAST_POLL_MS = 5_000;
const BACKOFF_AFTER_MS = 5 * 60_000;
const BACKOFF_POLL_MS = 30_000;
/// The worker's documented status vocabulary. The wire type is free text
/// (`status: string`), so this narrows it explicitly — an unrecognised value
/// reads as "pending" rather than slipping past the compiler.
export type TopupStatus = "pending" | "crediting" | "credited" | "rejected" | "expired";

/** Second-ticking countdown only in the final 10 minutes; absolute deadline before that. */
const EXPIRY_COUNTDOWN_FROM_MS = 10 * 60_000;

function formatIdr(locale: Locale, n: number): string {
  return `Rp${formatNumber(locale, n)}`;
}

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Ledger reason → dictionary key; unknown reasons fall back verbatim. */
const REASON_KEY: Record<string, TranslationKey> = {
  qris: "topup.history.reasonQris",
  usage: "topup.history.reasonUsage",
  media: "topup.history.reasonMedia",
  admin_adjustment: "topup.history.reasonAdminAdjustment",
  voucher: "topup.history.reasonVoucher",
  iap: "topup.history.reasonIap",
};

/** QR validity line — absolute deadline while far out, countdown only in the
 *  final 10 minutes. Owns its own 1s ticker so the page (and the QR) don't
 *  re-render every second. */
function Expiry({ expiresAt }: { expiresAt: number }) {
  const { t, fmtDate } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const remaining = Math.max(0, expiresAt * 1000 - now);
  if (remaining > EXPIRY_COUNTDOWN_FROM_MS) {
    return (
      <span className="text-muted-foreground">
        {t("topup.qr.validUntil")}{" "}
        <span className="font-mono tabular-nums">
          {fmtDate(expiresAt * 1000, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        </span>
      </span>
    );
  }
  return (
    <span className="text-warning">
      {t("topup.qr.expiresIn")} <span className="font-mono tabular-nums">{formatCountdown(remaining)}</span>
    </span>
  );
}

export function TopupPage() {
  const { locale, t, fmtNumber, fmtDate } = useI18n();

  // ── Top-up channel (QRIS vs Google Play IAP) ──────────────────────────────
  // Build Play (`release-android-play`) menjawab available=true dan halaman
  // ini menukar jalur QRIS + voucher dengan panel IAP (kebijakan Play:
  // barang digital wajib lewat Play Billing). Probe ke backend, bukan
  // probing plugin — plugin yang tidak ter-registered membuat semua invoke
  // gagal, sedangkan flag ini compile-time dari backend.
  //
  // Empat keadaan, dan hanya `qris` yang boleh merender jalur QRIS: build
  // Play TIDAK BOLEH jatuh ke QRIS hanya karena probe gagal (itu justru
  // kanal yang dilarang Play), jadi `probing` dan `failed` merender keadaan
  // netral + tombol coba lagi, bukan lane QRIS.
  type TopupChannel =
    | { kind: "probing" }
    | { kind: "qris" }
    | { kind: "iap"; accountHash: string }
    | { kind: "failed"; message: string };
  const [channel, setChannel] = useState<TopupChannel>({ kind: "probing" });
  const probeChannel = useCallback(() => {
    let cancelled = false;
    setChannel({ kind: "probing" });
    call<TopupIapAvailable>("topup_iap_available")
      .then(({ available, accountHash }) => {
        if (cancelled) return;
        setChannel(available ? { kind: "iap", accountHash } : { kind: "qris" });
      })
      .catch((err) => {
        if (!cancelled) setChannel({ kind: "failed", message: errText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => probeChannel(), [probeChannel]);
  const qrisLane = channel.kind === "qris";

  // ── Balance card — shared store (the rail chip, the submit gate and this
  // page all read the same value; `useTokenBalance` reads on mount) ─────────
  const { tokens: balance, pending: balancePending } = useTokenBalance();

  // ── Riwayat (balance ledger: kredit positif, pemakaian negatif) ──────────
  const [history, setHistory] = useState<TopupHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadHistory = useCallback(() => {
    void call<TopupHistory>("topup_history")
      .then(({ entries }) => {
        setHistory(entries);
        setHistoryError(null);
      })
      .catch((err) => setHistoryError(errText(err)));
  }, []);
  // Follows the shared balance: it settles once after mount, and every later
  // change (credited claim, a run's debit, focus refresh) re-reads the ledger.
  // While a read is pending the balance is about to change — wait for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `balance` is the TRIGGER (the effect re-runs when a settled read changes it), not a value it reads
  useEffect(() => {
    if (balancePending) return;
    loadHistory();
  }, [balance, balancePending, loadHistory]);

  // ── Package preview ───────────────────────────────────────────────────────
  const [preview, setPreview] = useState<TopupPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const loadPreview = useCallback(() => {
    setLoadingPreview(true);
    call<TopupPreview>("topup_qris_preview")
      .then((data) => {
        setPreview(data);
        setPreviewError(null);
      })
      .catch((err) => {
        setPreview(null);
        setPreviewError(errText(err));
      })
      .finally(() => setLoadingPreview(false));
  }, []);
  useEffect(() => {
    // Hanya lane QRIS yang memakai preview — build IAP jangan hit worker-nya,
    // dan probe yang belum/gagal selesai juga belum boleh menebak.
    if (!qrisLane) return;
    loadPreview();
  }, [loadPreview, qrisLane]);

  // ── Active-claim recovery ─────────────────────────────────────────────────
  // A pending claim survives reload/remount (one row per email server-side):
  // show its QR immediately instead of letting a fresh claim of a different
  // nominal hit the claim path. Best-effort — on failure the picker works.
  useEffect(() => {
    // Hanya lane QRIS yang punya claim aktif.
    if (!qrisLane) return;
    let cancelled = false;
    void call<TopupClaim | null>("topup_qris_active")
      .then((data) => {
        if (cancelled || data == null) return;
        claimStartRef.current = Date.now();
        setClaim(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [qrisLane]);

  // ── Amount picker (pay-as-you-go) ─────────────────────────────────────────
  const [amountInput, setAmountInput] = useState("");

  /** Base: integer, within [minBase, maxBase], kelipatan baseStep. */
  const base = Number(amountInput);
  const baseValid =
    amountInput !== "" &&
    Number.isInteger(base) &&
    preview != null &&
    base >= preview.minBase &&
    base <= preview.maxBase &&
    base % preview.baseStep === 0;

  // ── Active claim (the QR tx) ──────────────────────────────────────────────
  const [claim, setClaim] = useState<TopupClaim | null>(null);
  const [claimAmount, setClaimAmount] = useState<number | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<TopupStatusInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const claimStartRef = useRef(0);
  /** The claim currently OWNING the tx view. A status read that started for an
   *  older claim must not land after a newer claim took over — an old bill
   *  flipping `credited` mid-read would otherwise render the NEW claim as
   *  paid. Kept in a ref (state lags one render behind the async boundary). */
  const claimTxIdRef = useRef<string | null>(null);
  useEffect(() => {
    claimTxIdRef.current = claim?.txId ?? null;
  }, [claim]);

  const resetClaim = useCallback(() => {
    setClaim(null);
    setClaimAmount(null);
    setTxStatus(null);
    setClaimError(null);
    setLastCheckedAt(null);
  }, []);

  /** Claim a QR bill. Server contract: idempotent for the SAME base (an
   *  active pending row returns unchanged); a DIFFERENT base frees the old
   *  pending claim and allocates a fresh one — the response always bills the
   *  requested nominal. On any failure the tx state is cleared back to the
   *  picker. */
  const claimNow = useCallback(async (amount: number) => {
    setClaiming(true);
    setClaimError(null);
    try {
      const data = await call<TopupClaim>("topup_qris_claim", { amount });
      claimStartRef.current = Date.now();
      setClaimAmount(amount);
      setTxStatus(null);
      setClaim(data);
    } catch (err) {
      setClaim(null);
      setTxStatus(null);
      setClaimError(errText(err));
    } finally {
      setClaiming(false);
    }
  }, []);

  const rawStatus = txStatus?.status;
  const effectiveStatus: TopupStatus =
    rawStatus === "pending" ||
    rawStatus === "crediting" ||
    rawStatus === "credited" ||
    rawStatus === "rejected" ||
    rawStatus === "expired"
      ? rawStatus
      : "pending";
  const isTerminal = claim != null && effectiveStatus !== "pending" && effectiveStatus !== "crediting";
  /** Active (non-terminal) claim — rendered as a pending row in Riwayat. */
  const activeClaim = claim != null && !isTerminal ? claim : null;
  /** Verification adjustment: worker bills base + a 0–900 suffix so the bank
   *  mutation matches this claim exactly (auto-confirm). Derived from the
   *  CLAIM, never the typed amount — server idempotency can return an older
   *  pending claim whose base differs from what the user just typed.
   *  0 when the suffix happened to be 0. */
  const claimBase = claim && preview ? claim.tokens / preview.tokensPerIdr : null;
  const uniqueCode = claim && claimBase != null ? claim.idrAmount - claimBase : 0;

  /** One status read; credited re-reads the shared balance (the claim just
   *  landed). Transient errors keep the current view — polling and "Periksa
   *  pembayaran" retry. A null body (no such tx) clears the txId state. */
  const checkStatus = useCallback(async () => {
    if (!claim) return;
    const mine = claim;
    setChecking(true);
    try {
      const info = await call<TopupStatusInfo | null>("topup_qris_status", { txId: mine.txId });
      // A newer claim replaced this one while the read was on the wire: its
      // answer belongs to the old tx and must not paint the new claim's view.
      if (claimTxIdRef.current !== mine.txId) return;
      if (info == null) {
        resetClaim();
        setClaimError(t("topup.claim.notFound"));
        return;
      }
      setTxStatus(info);
      if (info.status === "credited") void refreshTokenBalance();
    } catch {
      // transient — keep the current state; manual check retries
    } finally {
      setChecking(false);
      setLastCheckedAt(Date.now());
    }
  }, [claim, resetClaim, t]);

  /** Cancel the pending claim (frees the unique nominal) and return to the
   *  picker. If the claim already moved on (crediting/credited — worker 409),
   *  refresh the status instead; the UI flips to the matching terminal view. */
  const cancelClaim = useCallback(async () => {
    if (!claim) return;
    setClaimError(null);
    try {
      await call("topup_qris_cancel", { txId: claim.txId });
      resetClaim();
    } catch {
      void checkStatus();
    }
  }, [claim, checkStatus, resetClaim]);

  // Status polling: 5s for the first 5 minutes after the claim, then 30s
  // backoff; stops entirely on a terminal status. "Periksa pembayaran" is
  // the manual escape hatch at any time.
  useEffect(() => {
    if (!claim || isTerminal) return;
    let cancelled = false;
    let timer: number | undefined;
    async function run() {
      await checkStatus();
      if (cancelled) return;
      schedule();
    }
    function schedule() {
      const fast = Date.now() - claimStartRef.current < BACKOFF_AFTER_MS;
      timer = window.setTimeout(() => void run(), fast ? FAST_POLL_MS : BACKOFF_POLL_MS);
    }
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [claim, isTerminal, checkStatus]);

  // At expiry the server flips pending → expired lazily ON READ — one
  // targeted status call at expiresAt surfaces the expired state at once.
  useEffect(() => {
    if (!claim || isTerminal) return;
    const delay = Math.max(0, claim.expiresAt * 1000 - Date.now());
    const t = setTimeout(() => void checkStatus(), delay);
    return () => clearTimeout(t);
  }, [claim, isTerminal, checkStatus]);

  // ── Voucher (kode sekali-pakai → token) ──────────────────────────────────
  const [voucherInput, setVoucherInput] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [voucherResult, setVoucherResult] = useState<TopupVoucherRedeem | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);

  /** Kode dinormalisasi: trim + uppercase (worker memvalidasi format). */
  const voucherCode = voucherInput.trim().toUpperCase();

  const redeemVoucher = useCallback(async () => {
    if (voucherCode === "" || redeeming) return;
    setRedeeming(true);
    setVoucherError(null);
    setVoucherResult(null);
    try {
      const data = await call<TopupVoucherRedeem>("topup_voucher_redeem", { code: voucherCode });
      setVoucherResult(data);
      setVoucherInput("");
      void refreshTokenBalance();
      loadHistory();
    } catch (err) {
      setVoucherResult(null);
      setVoucherError(errText(err));
    } finally {
      setRedeeming(false);
    }
  }, [voucherCode, redeeming, loadHistory]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AssetShell>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Card className="py-4">
          <CardContent className="px-4 text-sm">
            <p>
              <span className="text-muted-foreground">{t("topup.balanceLabel")}: </span>
              <span className="text-base font-semibold">
                {balance === null ? (balancePending ? "…" : "—") : fmtNumber(balance)}
              </span>
            </p>
            {isLowTokenBalance(balance) && <p className="text-warning mt-1 text-xs">{t("topup.balanceLowHint")}</p>}
          </CardContent>
        </Card>

        {/* Voucher card — terletak setelah saldo, di luar claim ternary.
            Build IAP menyembunyikannya: kode yang dijual di luar Play untuk
            barang digital melanggar kebijakan Play Billing. */}
        {qrisLane && (
          <section className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">Voucher</h3>
              <span className="text-muted-foreground text-xs">{t("topup.voucher.oneTimeCode")}</span>
            </div>
            <div className="space-y-3">
              <Input
                placeholder={t("topup.voucher.placeholder")}
                value={voucherInput}
                onChange={(e) => setVoucherInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void redeemVoucher();
                  }
                }}
                disabled={redeeming}
                className="font-mono uppercase tracking-wider"
              />
              <Button onClick={redeemVoucher} disabled={redeeming || voucherCode === ""} className="w-full">
                {redeeming ? (
                  <>
                    <Spinner className="mr-2 size-4 animate-spin" />
                    {t("topup.voucher.redeeming")}
                  </>
                ) : (
                  t("topup.voucher.redeem")
                )}
              </Button>
              {voucherResult && (
                <div className="rounded-md border border-success/20 bg-success/5 p-3 text-xs">
                  <p className="font-medium text-success">{t("topup.voucher.successTitle")}</p>
                  <p className="text-muted-foreground">
                    {t("topup.voucher.credited", { tokens: fmtNumber(voucherResult.tokens) })}
                  </p>
                  <p className="text-muted-foreground">
                    {t("topup.voucher.balanceNow", { balance: fmtNumber(voucherResult.balance) })}
                  </p>
                </div>
              )}
              {voucherError && (
                <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
                  <p className="text-warning font-medium">{t("topup.voucher.failedTitle")}</p>
                  <p className="text-muted-foreground font-mono break-words">{voucherError}</p>
                </div>
              )}
            </div>
          </section>
        )}

        {channel.kind === "iap" ? (
          // ── Google Play Billing (build release-android-play) ─────────────
          <IapPanel accountHash={channel.accountHash} />
        ) : channel.kind === "probing" ? (
          // Probe kanal belum selesai — jangan tebak QRIS (di build Play itu
          // kanal yang dilarang). Netral, tanpa memanggil worker apa pun.
          <section className="flex items-center justify-center rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-8">
            <Spinner />
          </section>
        ) : channel.kind === "failed" ? (
          <section className="border-warning/30 space-y-2 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4 text-sm">
            <p className="text-warning font-medium">{t("topup.channel.unreadableTitle")}</p>
            <p className="text-muted-foreground font-mono text-xs break-words">{channel.message}</p>
            <p className="text-muted-foreground text-xs">{t("topup.channel.safeNote")}</p>
            <Button
              onClick={() => {
                probeChannel();
              }}
              size="sm"
              variant="outline"
            >
              <Icon name="rotate-ccw" className="size-3.5" />
              {t("common.retry")}
            </Button>
          </section>
        ) : claim ? (
          isTerminal ? (
            // ── Terminal states ─────────────────────────────────────────────
            <section className="space-y-3 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <p className="text-muted-foreground font-mono text-xs break-all">tx: {claim.txId}</p>
              <p className="text-lg font-semibold">{formatIdr(locale, claim.idrAmount)}</p>
              {effectiveStatus === "credited" && txStatus ? (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="check-circle-2" className="size-4 text-success" />
                    <span className="font-medium text-success">{t("topup.claim.creditedTitle")}</span>
                    <span className="text-muted-foreground">+{fmtNumber(txStatus.tokens)} token</span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("topup.claim.balanceLine")}{" "}
                    <span className="font-medium">{balance === null ? "—" : fmtNumber(balance)}</span>
                  </p>
                  <Button onClick={resetClaim} size="sm" variant="outline">
                    {t("topup.claim.topUpAgain")}
                  </Button>
                </>
              ) : effectiveStatus === "rejected" ? (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="circle-x" className="size-4 text-destructive" />
                    <span className="font-medium text-destructive">{t("topup.claim.rejectedTitle")}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">{t("topup.claim.rejectedNote")}</p>
                  <Button onClick={resetClaim} size="sm" variant="outline">
                    {t("topup.claim.topUpAgain")}
                  </Button>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="alert-circle" className="size-4 text-warning" />
                    <span className="font-medium text-warning">{t("topup.claim.expiredTitle")}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">{t("topup.claim.expiredNote")}</p>
                  <Button
                    disabled={claiming}
                    onClick={() => {
                      if (claimAmount != null) void claimNow(claimAmount);
                      else resetClaim();
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {claiming ? <Spinner className="size-4" /> : <Icon name="rotate-ccw" className="size-3.5" />}
                    {t("topup.claim.newClaim")}
                  </Button>
                </>
              )}
            </section>
          ) : (
            // ── Pending / crediting: QR + instructions ──────────────────────
            <section className="space-y-4 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                <QrisCard qrPayload={claim.qrPayload} amountLabel={formatIdr(locale, claim.idrAmount)} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-muted-foreground text-xs">{t("topup.claim.totalLabel")}</p>
                  <p className="text-xl font-semibold">{formatIdr(locale, claim.idrAmount)}</p>
                  <p className="text-xs">{t("topup.claim.youReceive", { tokens: fmtNumber(claim.tokens) })}</p>
                  {uniqueCode > 0 && (
                    <details className="group text-xs">
                      <summary className="text-muted-foreground [&::-webkit-details-marker]:hidden hit-44 flex cursor-pointer list-none items-center gap-1.5 py-1 select-none hover:text-foreground">
                        <Icon name="info" className="size-3.5" />
                        {t("topup.claim.whyDifferent")}
                      </summary>
                      <div className="border-border/60 mt-2 space-y-0.5 border-l pl-3">
                        <p className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t("topup.claim.amountLabel")}</span>
                          <span className="font-medium">{formatIdr(locale, claim.idrAmount - uniqueCode)}</span>
                        </p>
                        <p className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t("topup.claim.adjustmentLabel")}</span>
                          <span className="font-medium">{formatIdr(locale, uniqueCode)}</span>
                        </p>
                        <p className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t("topup.claim.totalLabel")}</span>
                          <span className="font-medium">{formatIdr(locale, claim.idrAmount)}</span>
                        </p>
                        <p className="text-muted-foreground pt-1">{t("topup.claim.adjustmentNote")}</p>
                      </div>
                    </details>
                  )}
                  <p className="text-muted-foreground font-mono text-xs break-all">tx: {claim.txId}</p>
                  <p className="text-xs">
                    <Expiry expiresAt={claim.expiresAt} />
                  </p>
                </div>
              </div>
              <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
                <p>{t("topup.claim.payExact", { amount: formatIdr(locale, claim.idrAmount) })}</p>
                <p className="text-muted-foreground">{t("topup.claim.differentNote")}</p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Spinner className="size-3.5" />
                  {effectiveStatus === "crediting" ? (
                    t("topup.claim.crediting")
                  ) : (
                    <>
                      {t("topup.claim.waiting")}
                      {lastCheckedAt != null && (
                        <>
                          {" · "}
                          {t("topup.claim.lastCheck", {
                            time: fmtDate(lastCheckedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
                          })}
                        </>
                      )}
                    </>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    disabled={effectiveStatus === "crediting"}
                    onClick={() => void cancelClaim()}
                    size="sm"
                    variant="ghost"
                  >
                    {t("topup.claim.changeAmount")}
                  </Button>
                  <Button disabled={checking} onClick={() => void checkStatus()} size="sm" variant="outline">
                    <Icon name="rotate-ccw" className="size-3.5" />
                    {t("topup.claim.checkPayment")}
                  </Button>
                </div>
              </div>
            </section>
          )
        ) : loadingPreview ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : previewError ? (
          // ── Not configured (503 QRIS_PAYLOAD) or preview failure — a notice, never a crash ──
          <div className="border-warning/30 space-y-2 rounded-md border p-4 text-sm">
            <p className="font-medium text-warning">
              {previewError.includes("QRIS_PAYLOAD")
                ? t("topup.preview.qrisNotConfigured")
                : t("topup.preview.loadFailed")}
            </p>
            <p className="text-muted-foreground font-mono text-xs break-words">{previewError}</p>
            <Button onClick={loadPreview} size="sm" variant="outline">
              {t("common.retry")}
            </Button>
          </div>
        ) : preview == null ? (
          <p className="text-muted-foreground text-sm">{t("topup.preview.notLoaded")}</p>
        ) : (
          // ── Amount picker (pay-as-you-go) ─────────────────────────────────
          <>
            <h3 className="text-sm font-medium">{t("topup.picker.title")}</h3>
            <div className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <div className="flex items-center gap-2">
                <Input
                  className="w-40 font-semibold"
                  inputMode="numeric"
                  onChange={(e) => setAmountInput(e.target.value.replace(/\D/g, "").slice(0, 9))}
                  placeholder={fmtNumber(preview.minBase)}
                  type="text"
                  value={amountInput === "" ? "" : fmtNumber(Number(amountInput))}
                />
                <span className="text-muted-foreground text-sm">IDR</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[10000, 30000, 50000, 99000].map((preset) => {
                  const selected = baseValid && base === preset;
                  return (
                    <button
                      aria-pressed={selected}
                      className={cn(
                        "rounded-md border px-3 py-1 text-xs transition-colors disabled:opacity-50 max-md:min-h-11",
                        selected
                          ? "border-transparent bg-primary font-medium text-primary-foreground"
                          : "hover:bg-[var(--tea-color-bg-secondary-default)]",
                      )}
                      disabled={claiming}
                      key={preset}
                      onClick={() => setAmountInput(String(preset))}
                      type="button"
                    >
                      {formatIdr(locale, preset)}
                    </button>
                  );
                })}
              </div>
              {baseValid ? (
                <div className="mt-3 space-y-1 text-xs">
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t("topup.claim.amountLabel")}</span>
                    <span className="font-medium">{formatIdr(locale, base)}</span>
                  </p>
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{t("topup.picker.tokensReceivedLabel")}</span>
                    <span className="font-medium">
                      {t("topup.picker.tokensReceived", {
                        tokens: fmtNumber(base * preview.tokensPerIdr),
                        perIdr: preview.tokensPerIdr,
                      })}
                    </span>
                  </p>
                  <p className="text-muted-foreground">{t("topup.picker.totalAfterQr")}</p>
                </div>
              ) : (
                <p className="text-muted-foreground mt-3 text-xs">
                  {t("topup.picker.rangeHint", {
                    min: fmtNumber(preview.minBase),
                    max: fmtNumber(preview.maxBase),
                    step: preview.baseStep,
                  })}
                </p>
              )}
            </div>
            <Button className="w-full" disabled={!baseValid || claiming} onClick={() => void claimNow(base)}>
              {claiming ? <Spinner className="size-4" /> : <Icon name="qr-code" className="size-4" />}
              {t("topup.picker.createQr")}
            </Button>
            {claimError && <p className="text-destructive text-xs">{claimError}</p>}
          </>
        )}

        {/* Riwayat ledger — kredit (+) dan pemakaian (−), terbaru dulu.
            A read error only surfaces while there is nothing to show; a
            previously loaded list stays (same policy as the balance card). */}
        <section className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{t("topup.history.title")}</h3>
            <Button onClick={loadHistory} size="sm" variant="ghost">
              <Icon name="rotate-ccw" className="size-3.5" />
              {t("topup.history.refresh")}
            </Button>
          </div>
          {history == null ? (
            historyError ? (
              <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
                <p className="text-warning font-medium">{t("topup.history.unavailable")}</p>
                <p className="text-muted-foreground font-mono break-words">{historyError}</p>
                <Button onClick={loadHistory} size="sm" variant="outline">
                  {t("common.retry")}
                </Button>
              </div>
            ) : (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            )
          ) : history.length === 0 && activeClaim == null ? (
            <p className="text-muted-foreground text-sm">{t("topup.history.empty")}</p>
          ) : (
            <ul>
              {activeClaim && (
                <li className="flex items-center justify-between gap-3 border-b py-2 text-sm">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-warning font-mono font-medium tabular-nums">
                      {fmtNumber(activeClaim.tokens)} token
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {effectiveStatus === "crediting"
                        ? t("topup.history.pendingProcessing")
                        : t("topup.history.pendingWaiting")}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {fmtDate(claimStartRef.current, {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              )}
              {history.map((entry) => {
                const reasonKey = REASON_KEY[entry.reason];
                return (
                  <li
                    className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0"
                    key={entry.id}
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span
                        className={`font-mono font-medium tabular-nums ${
                          entry.amount >= 0 ? "text-success" : "text-destructive"
                        }`}
                      >
                        {entry.amount >= 0 ? "+" : "−"}
                        {fmtNumber(Math.abs(entry.amount))} token
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {reasonKey ? t(reasonKey) : entry.reason}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {fmtDate(entry.createdAt, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </AssetShell>
  );
}
