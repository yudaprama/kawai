import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { call, errText } from "@/lib/api";
import { QrisCard } from "@/features/topup/qris-card";

// ── Wire shapes (camelCase JSON — local mirrors of the worker contract) ─────

export interface TopupPreview {
  qrPayload: string;
  /** Inclusive base range (IDR) the user may request. */
  minBase: number;
  maxBase: number;
  /** Base must be a multiple of this (1000). */
  baseStep: number;
  /** `tokens = base * tokensPerIdr`. */
  tokensPerIdr: number;
}

export interface TopupClaim {
  txId: string;
  idrAmount: number;
  tokens: number;
  qrPayload: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type TopupStatus = "pending" | "crediting" | "credited" | "rejected" | "expired";

export interface TopupStatusInfo {
  status: TopupStatus;
  idrAmount: number;
  tokens: number;
  createdAt: number;
  creditedAt?: number | null;
}

interface TopupBalance {
  tokens: number;
}

// ── Constants (source-hardcoded — repo rule: no new env) ────────────────────

/** First 5 minutes poll fast; after that the check backs off (manual refresh stays). */
const FAST_POLL_MS = 5_000;
const BACKOFF_AFTER_MS = 5 * 60_000;
const BACKOFF_POLL_MS = 30_000;
const TERMINAL_STATUSES: readonly TopupStatus[] = ["credited", "rejected", "expired"];

function formatIdr(n: number): string {
  return `Rp${n.toLocaleString("id-ID")}`;
}

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Live countdown to `expiresAt` — owns its own 1s ticker so the page (and
 *  the QR) don't re-render every second. */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums">{formatCountdown(Math.max(0, expiresAt * 1000 - now))}</span>;
}

export function TopupPage({ onBack }: { onBack: () => void }) {
  // ── Balance card ──────────────────────────────────────────────────────────
  const [balance, setBalance] = useState<number | null>(null);
  const loadBalance = useCallback(() => {
    void call<TopupBalance>("topup_balance")
      .then(({ tokens }) => setBalance(tokens))
      .catch(() => setBalance(null));
  }, []);
  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

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
    loadPreview();
  }, [loadPreview]);

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
  const claimStartRef = useRef(0);

  const resetClaim = useCallback(() => {
    setClaim(null);
    setClaimAmount(null);
    setTxStatus(null);
    setClaimError(null);
  }, []);

  /** Claim (idempotent server-side: one active pending row per email — an
   *  existing pending claim returns unchanged regardless of the requested
   *  base). On any failure the tx state is cleared back to the picker. */
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

  const effectiveStatus: TopupStatus = txStatus?.status ?? "pending";
  const isTerminal = claim != null && TERMINAL_STATUSES.includes(effectiveStatus);

  /** One status read; credited refreshes the balance card. Transient errors
   *  keep the current view — polling and "Cek ulang" retry. A null body (no
   *  such tx) clears the txId state. */
  const checkStatus = useCallback(async () => {
    if (!claim) return;
    setChecking(true);
    try {
      const info = await call<TopupStatusInfo | null>("topup_qris_status", { txId: claim.txId });
      if (info == null) {
        resetClaim();
        setClaimError("Transaksi tidak ditemukan — silakan klaim baru");
        return;
      }
      setTxStatus(info);
      if (info.status === "credited") loadBalance();
    } catch {
      // transient — keep the current state; manual check retries
    } finally {
      setChecking(false);
    }
  }, [claim, loadBalance, resetClaim]);

  // Status polling: 5s for the first 5 minutes after the claim, then 30s
  // backoff; stops entirely on a terminal status. "Cek ulang" is the manual
  // escape hatch at any time.
  useEffect(() => {
    if (!claim || TERMINAL_STATUSES.includes(effectiveStatus)) return;
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
  }, [claim, effectiveStatus, checkStatus]);

  // At expiry the server flips pending → expired lazily ON READ — one
  // targeted status call at expiresAt surfaces the expired state at once.
  useEffect(() => {
    if (!claim || isTerminal) return;
    const delay = Math.max(0, claim.expiresAt * 1000 - Date.now());
    const t = setTimeout(() => void checkStatus(), delay);
    return () => clearTimeout(t);
  }, [claim, isTerminal, checkStatus]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AssetShell title="Top Up" subtitle="QRIS · app tokens" onBack={onBack}>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Card className="py-4">
          <CardContent className="px-4 text-sm">
            <p>
              <span className="text-muted-foreground">Saldo token: </span>
              <span className="text-base font-semibold">
                {balance === null ? "—" : balance.toLocaleString("id-ID")}
              </span>
              {balance === 0 && <span className="text-muted-foreground ml-2 text-xs">Hubungi admin</span>}
            </p>
          </CardContent>
        </Card>

        {claim ? (
          isTerminal ? (
            // ── Terminal states ─────────────────────────────────────────────
            <section className="space-y-3 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <p className="text-muted-foreground font-mono text-xs break-all">tx: {claim.txId}</p>
              <p className="text-lg font-semibold">{formatIdr(claim.idrAmount)}</p>
              {effectiveStatus === "credited" && txStatus ? (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="check-circle-2" className="size-4 text-emerald-500" />
                    <span className="font-medium text-emerald-500">Masuk ✓</span>
                    <span className="text-muted-foreground">+{txStatus.tokens} token</span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Saldo token:{" "}
                    <span className="font-medium">{balance === null ? "—" : balance.toLocaleString("id-ID")}</span>
                  </p>
                  <Button onClick={resetClaim} size="sm" variant="outline">
                    Top up lagi
                  </Button>
                </>
              ) : effectiveStatus === "rejected" ? (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="circle-x" className="size-4 text-destructive" />
                    <span className="font-medium text-destructive">Ditolak admin</span>
                  </p>
                  <p className="text-muted-foreground text-xs">Transfer tidak cocok dengan mutasi bank.</p>
                  <Button onClick={resetClaim} size="sm" variant="outline">
                    Top up lagi
                  </Button>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-sm">
                    <Icon name="alert-circle" className="size-4 text-amber-500" />
                    <span className="font-medium text-amber-500">Klaim kedaluwarsa</span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Nominal telah dibebaskan — transfer ke QR lama tidak dikreditkan.
                  </p>
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
                    Klaim baru
                  </Button>
                </>
              )}
            </section>
          ) : (
            // ── Pending / crediting: QR + instructions ──────────────────────
            <section className="space-y-4 rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                <QrisCard qrPayload={claim.qrPayload} amountLabel={formatIdr(claim.idrAmount)} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-xl font-semibold">{formatIdr(claim.idrAmount)}</p>
                  <p className="text-muted-foreground text-xs">Bayar lewat aplikasi bank / e-wallet (QRIS)</p>
                  <p className="text-muted-foreground font-mono text-xs break-all">tx: {claim.txId}</p>
                  <p className="text-xs">
                    <span className="text-muted-foreground">Berlaku </span>
                    <Countdown expiresAt={claim.expiresAt} />
                  </p>
                  <p className="text-xs">+{claim.tokens} token setelah terverifikasi</p>
                </div>
              </div>
              <div className="border-amber-500/30 space-y-1 rounded-md border p-3 text-xs">
                <p>Transfer tepat sesuai nominal — nominal salah tidak otomatis dikreditkan</p>
                <p>Setelah bayar, tunggu verifikasi admin</p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Spinner className="size-3.5" />
                  {effectiveStatus === "crediting" ? "Sedang dikreditkan…" : "Menunggu verifikasi admin"}
                </p>
                <Button disabled={checking} onClick={() => void checkStatus()} size="sm" variant="outline">
                  <Icon name="rotate-ccw" className="size-3.5" />
                  Cek ulang
                </Button>
              </div>
            </section>
          )
        ) : loadingPreview ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : previewError ? (
          // ── Not configured (503 QRIS_PAYLOAD) or preview failure — a notice, never a crash ──
          <div className="border-amber-500/30 space-y-2 rounded-md border p-4 text-sm">
            <p className="font-medium text-amber-500">
              {previewError.includes("QRIS_PAYLOAD") ? "QRIS belum dikonfigurasi" : "Gagal memuat pengaturan"}
            </p>
            <p className="text-muted-foreground font-mono text-xs break-words">{previewError}</p>
            <Button onClick={loadPreview} size="sm" variant="outline">
              Coba lagi
            </Button>
          </div>
        ) : preview == null ? (
          <p className="text-muted-foreground text-sm">Pengaturan top-up belum dimuat.</p>
        ) : (
          // ── Amount picker (pay-as-you-go) ─────────────────────────────────
          <>
            <h3 className="text-sm font-medium">Nominal top-up</h3>
            <div className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
              <div className="flex items-center gap-2">
                <Input
                  className="w-40 font-semibold"
                  inputMode="numeric"
                  max={preview.maxBase}
                  min={preview.minBase}
                  onChange={(e) => setAmountInput(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder={String(preview.minBase)}
                  step={preview.baseStep}
                  type="number"
                  value={amountInput}
                />
                <span className="text-muted-foreground text-sm">IDR</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[10000, 30000, 50000, 99000].map((preset) => (
                  <button
                    className="hover:bg-[var(--tea-color-bg-secondary-default)] rounded-md border px-3 py-1 text-xs transition-colors disabled:opacity-50"
                    disabled={claiming}
                    key={preset}
                    onClick={() => setAmountInput(String(preset))}
                    type="button"
                  >
                    {formatIdr(preset)}
                  </button>
                ))}
              </div>
              <p className="text-muted-foreground mt-3 text-xs">
                {baseValid
                  ? `+${(base * preview.tokensPerIdr).toLocaleString("id-ID")} token — bayar nominal persis yang tampil setelah klaim`
                  : `Masukkan ${preview.minBase.toLocaleString("id-ID")}–${preview.maxBase.toLocaleString("id-ID")}, kelipatan ${preview.baseStep}`}
              </p>
            </div>
            <Button className="w-full" disabled={!baseValid || claiming} onClick={() => void claimNow(base)}>
              {claiming ? <Spinner className="size-4" /> : <Icon name="qr-code" className="size-4" />}
              Buat QR
            </Button>
            {claimError && <p className="text-destructive text-xs">{claimError}</p>}
          </>
        )}
      </div>
    </AssetShell>
  );
}
