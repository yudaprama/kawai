import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { call, errText } from "@/lib/api";
import { QrisCard } from "@/features/topup/qris-card";
import { isLowTokenBalance, refreshTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";

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

export interface HistoryEntry {
  /** Ledger primary key — the stable row key for the list. */
  id: number;
  /** Signed: kredit positif, pemakaian negatif. */
  amount: number;
  /** `qris | usage | admin_adjustment`. */
  reason: string;
  /** Unix seconds. */
  createdAt: number;
}

interface History {
  entries: HistoryEntry[];
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

/** Ledger reason → Indonesian label; unknown reasons fall back verbatim. */
const REASON_LABEL: Record<string, string> = {
  qris: "Top up QRIS",
  usage: "Pemakaian run",
  admin_adjustment: "Penyesuaian admin",
};

function formatWhen(unix: number): string {
  return new Date(unix * 1000).toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  // ── Balance card — shared store (the rail chip, the submit gate and this
  // page all read the same value; `useTokenBalance` reads on mount) ─────────
  const { tokens: balance, pending: balancePending } = useTokenBalance();

  // ── Riwayat (balance ledger: kredit positif, pemakaian negatif) ──────────
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadHistory = useCallback(() => {
    void call<History>("topup_history")
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
  /** Active (non-terminal) claim — rendered as a pending row in Riwayat. */
  const activeClaim = claim != null && !isTerminal ? claim : null;
  /** Worker bills base + a unique 0–900 suffix so the bank mutation matches
   *  this claim exactly (auto-confirm); 0 when the suffix happened to be 0. */
  const uniqueCode = claim ? claim.idrAmount - (claimAmount ?? claim.idrAmount) : 0;

  /** One status read; credited re-reads the shared balance (the claim just
   *  landed). Transient errors
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
      if (info.status === "credited") void refreshTokenBalance();
    } catch {
      // transient — keep the current state; manual check retries
    } finally {
      setChecking(false);
    }
  }, [claim, resetClaim]);

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
                {balance === null ? (balancePending ? "…" : "—") : balance.toLocaleString("id-ID")}
              </span>
            </p>
            {isLowTokenBalance(balance) && (
              <p className="text-amber-500 mt-1 text-xs">
                Saldo menipis — isi ulang sebelum menjalankan run berikutnya.
              </p>
            )}
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
                    <span className="text-muted-foreground">+{txStatus.tokens.toLocaleString("id-ID")} token</span>
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
                  <p className="text-muted-foreground text-xs">Total pembayaran</p>
                  <p className="text-xl font-semibold">{formatIdr(claim.idrAmount)}</p>
                  {uniqueCode > 0 && (
                    <div className="space-y-0.5 text-xs">
                      <p className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Nominal top-up</span>
                        <span className="font-medium">{formatIdr(claimAmount ?? claim.idrAmount)}</span>
                      </p>
                      <p className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Kode unik</span>
                        <span className="font-medium">{formatIdr(uniqueCode)}</span>
                      </p>
                    </div>
                  )}
                  <p className="text-xs">
                    +{claim.tokens.toLocaleString("id-ID")} token
                    {preview != null && <> · Rp1 = {preview.tokensPerIdr} token</>}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Bayar lewat aplikasi bank / e-wallet (QRIS) — nominal terisi otomatis saat scan
                  </p>
                  <p className="text-muted-foreground font-mono text-xs break-all">tx: {claim.txId}</p>
                  <p className="text-xs">
                    <span className="text-muted-foreground">QR berlaku </span>
                    <Countdown expiresAt={claim.expiresAt} />
                    <span className="text-muted-foreground"> lagi</span>
                  </p>
                </div>
              </div>
              <div className="border-amber-500/30 space-y-1 rounded-md border p-3 text-xs">
                <p>
                  Bayar tepat {formatIdr(claim.idrAmount)} — nominal persis inilah yang mencocokkan pembayaran secara
                  otomatis.
                </p>
                <p className="text-muted-foreground">
                  Nominal berbeda tidak terdeteksi otomatis dan menunggu pemeriksaan manual (lebih lama).
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Spinner className="size-3.5" />
                  {effectiveStatus === "crediting"
                    ? "Pembayaran diterima — sedang menambahkan token…"
                    : "Menunggu pembayaran — status diperbarui otomatis"}
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
                  onChange={(e) => setAmountInput(e.target.value.replace(/\D/g, "").slice(0, 9))}
                  placeholder={preview.minBase.toLocaleString("id-ID")}
                  type="text"
                  value={amountInput === "" ? "" : Number(amountInput).toLocaleString("id-ID")}
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
              {baseValid ? (
                <div className="mt-3 space-y-1 text-xs">
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Token diterima</span>
                    <span className="font-medium">
                      +{(base * preview.tokensPerIdr).toLocaleString("id-ID")} token · Rp1 = {preview.tokensPerIdr}{" "}
                      token
                    </span>
                  </p>
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Nominal</span>
                    <span className="font-medium">{formatIdr(base)}</span>
                  </p>
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Kode unik</span>
                    <span className="font-medium">Rp0–Rp900 — ditentukan saat klaim</span>
                  </p>
                  <p className="text-muted-foreground">
                    Kode unik membuat pembayaran terdeteksi otomatis. Nominal final tampil di QR dan terisi sendiri saat
                    scan.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground mt-3 text-xs">
                  Masukkan {preview.minBase.toLocaleString("id-ID")}–{preview.maxBase.toLocaleString("id-ID")},
                  kelipatan {preview.baseStep}
                </p>
              )}
            </div>
            <Button className="w-full" disabled={!baseValid || claiming} onClick={() => void claimNow(base)}>
              {claiming ? <Spinner className="size-4" /> : <Icon name="qr-code" className="size-4" />}
              Buat QR Pembayaran
            </Button>
            {claimError && <p className="text-destructive text-xs">{claimError}</p>}
          </>
        )}

        {/* Riwayat ledger — kredit (+) dan pemakaian (−), terbaru dulu.
            A read error only surfaces while there is nothing to show; a
            previously loaded list stays (same policy as the balance card). */}
        <section className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Riwayat</h3>
            <Button onClick={loadHistory} size="sm" variant="ghost">
              <Icon name="rotate-ccw" className="size-3.5" />
              Muat ulang
            </Button>
          </div>
          {history == null ? (
            historyError ? (
              <div className="border-amber-500/30 space-y-1 rounded-md border p-3 text-xs">
                <p className="text-amber-500 font-medium">Riwayat tidak tersedia</p>
                <p className="text-muted-foreground font-mono break-words">{historyError}</p>
                <Button onClick={loadHistory} size="sm" variant="outline">
                  Coba lagi
                </Button>
              </div>
            ) : (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            )
          ) : history.length === 0 && activeClaim == null ? (
            <p className="text-muted-foreground text-sm">Belum ada transaksi.</p>
          ) : (
            <ul>
              {activeClaim && (
                <li className="flex items-center justify-between gap-3 border-b py-2 text-sm">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono font-medium text-emerald-500 tabular-nums">
                      +{activeClaim.tokens.toLocaleString("id-ID")} token
                    </span>
                    <span className="truncate text-xs text-amber-500">
                      Top up QRIS — {effectiveStatus === "crediting" ? "diproses" : "menunggu pembayaran"}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatWhen(Math.floor(claimStartRef.current / 1000))}
                  </span>
                </li>
              )}
              {history.map((entry) => (
                <li
                  className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0"
                  key={entry.id}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={`font-mono font-medium tabular-nums ${
                        entry.amount >= 0 ? "text-emerald-500" : "text-destructive"
                      }`}
                    >
                      {entry.amount >= 0 ? "+" : "−"}
                      {Math.abs(entry.amount).toLocaleString("id-ID")} token
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {REASON_LABEL[entry.reason] ?? entry.reason}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {formatWhen(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AssetShell>
  );
}
