// Google Play Billing top-up panel (build `release-android-play` saja).
//
// Alur: katalog server (`topup_iap_products`, productId → tokens) digabung
// harga terlokalisasi dari Play (plugin `get_products`), user membeli via
// `purchase("inapp")`, hasilnya diverifikasi + dikredit worker
// (`topup_iap_redeem`), lalu pembelian di-consume agar bisa dibeli lagi.
// Verifikasi/kredit HANYA lewat worker — harga/token dari klien tidak pernah
// dipercaya. Pembelian PENDING (mis. bayar di minimarket) dipolling lewat
// `restore_purchases`; crash di titik mana pun sembuh lewat recovery mount
// (pembelian belum di-consume selalu muncul di restore).
import { useCallback, useEffect, useRef, useState } from "react";

import {
  consumePurchase,
  getProducts,
  PurchaseState,
  purchase as iapPurchase,
  restorePurchases,
  type Purchase,
} from "@choochmeque/tauri-plugin-iap-api";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { refreshTokenBalance } from "@/features/topup/use-token-balance";
import { logError, logWarn } from "@/lib/logger";
import { call, errText, type TopupIapProduct, type TopupIapProducts, type TopupIapRedeem } from "@/lib/api";

/** Jeda polling pembelian pending (bayar di minimarket/GoPay bisa berjam-jam). */
const PENDING_POLL_MS = 30_000;
/** Batas polling per sesi halaman — setelah itu banner menyarankan buka ulang
 *  aplikasi (recovery mount mengkredit pembelian yang sudah dibayar). */
const PENDING_POLL_MAX_TICKS = 60;

/** Kode error worker → kalimat untuk pembeli. Pesan internal (perintah
 *  wrangler, teks upstream Google, error D1) tidak pernah tampil mentah —
 *  aslinya tetap masuk konsol untuk diagnosa. */
const ERROR_TEXT: Record<string, string> = {
  iap_not_configured: "Top-up lewat Google Play belum diaktifkan untuk aplikasi ini.",
  purchase_account_mismatch: "Pembelian ini dibuat oleh akun kawai lain di perangkat ini.",
  purchase_account_unbound: "Pembelian ini tidak terhubung ke akun kawai — hubungi dukungan dengan kode pembelian.",
  purchase_not_purchased_pending: "Pembayaran belum selesai — selesaikan dulu di Google Play.",
  purchase_not_purchased_canceled: "Pembelian dibatalkan.",
  purchase_not_purchased_unknown: "Google Play menolak status pembelian ini.",
  purchase_token_taken: "Token pembelian ini sudah dipakai untuk transaksi lain.",
  purchase_package_mismatch: "Pembelian ini bukan untuk aplikasi kawai.",
  purchase_verify_failed: "Google Play belum bisa memverifikasi pembelian — coba lagi sebentar.",
  order_id_taken: "Nomor pesanan ini sudah terpakai di akun lain.",
  unknown_product: "Produk ini tidak ada di katalog.",
  claim_failed: "Pembelian gagal dicatat — coba lagi.",
  credit_failed: "Kredit token gagal dicatat — coba lagi.",
};

/** Error yang TIDAK sembuh dengan retry (milik akun lain, produk salah, token
 *  terpakai): jangan diputar ulang tiap mount/poll dengan banner yang sama. */
const TERMINAL_ERRORS = [
  "purchase_account_mismatch",
  "purchase_account_unbound",
  "purchase_package_mismatch",
  "purchase_not_purchased_canceled",
  "purchase_not_purchased_unknown",
  "purchase_token_taken",
  "unknown_product",
];

function friendlyTopupError(raw: string): string {
  const code = Object.keys(ERROR_TEXT).find((key) => raw.includes(key));
  return code ? ERROR_TEXT[code] : raw;
}

function isTerminalTopupError(raw: string): boolean {
  return TERMINAL_ERRORS.some((code) => raw.includes(code));
}

export function IapPanel({ accountHash }: { accountHash: string }) {
  // ── Katalog worker (productId → tokens) + produk Play (harga terlokalisasi)
  const [catalog, setCatalog] = useState<TopupIapProduct[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [storePrices, setStorePrices] = useState<Map<string, string>>(new Map());
  const [storeMissing, setStoreMissing] = useState(false);

  // ── Transaksi berjalan + hasil terakhir ──────────────────────────────────
  const [busy, setBusy] = useState<{ productId: string; phase: "purchase" | "verify" } | null>(null);
  const [credited, setCredited] = useState<{ tokens: number; balance: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTerminal, setErrorTerminal] = useState(false);
  const [pending, setPending] = useState<{ productId: string; purchaseToken: string } | null>(null);
  const [pollExpired, setPollExpired] = useState(false);
  /** Percobaan ulang kueri produk Play (state "produk belum aktif"). */
  const [storeAttempt, setStoreAttempt] = useState(0);
  const busyRef = useRef(false);
  /** Token pembelian yang ditolak permanen — tidak di-redeem ulang. */
  const stuckRef = useRef<Set<string>>(new Set());

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    call<TopupIapProducts>("topup_iap_products")
      .then(({ products }) => setCatalog(products))
      .catch((err) => {
        setCatalog(null);
        // Detail mentah ke log (app.log + Sentry), kalimat manusia ke UI.
        logError("topup_iap_products", err);
        setCatalogError(friendlyTopupError(errText(err)));
      });
  }, []);
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // Harga Play untuk produk katalog — sekali per katalog. Daftar kosong berarti
  // produk IAP belum dibuat di Play Console (bukan error UI).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `storeAttempt` is the "Cek ulang" TRIGGER (it is never read inside the effect), not a value the effect depends on
  useEffect(() => {
    if (catalog == null || catalog.length === 0) return;
    let cancelled = false;
    setStoreMissing(false);
    getProducts(
      catalog.map((p) => p.productId),
      "inapp",
    )
      .then(({ products }) => {
        if (cancelled) return;
        setStorePrices(new Map(products.map((p) => [p.productId, p.formattedPrice ?? ""])));
        setStoreMissing(products.length === 0);
      })
      .catch(() => {
        if (!cancelled) setStoreMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, storeAttempt]);

  // ── Verify + credit + consume ────────────────────────────────────────────
  // Idempoten di worker (per orderId) — retry aman. consume HANYA setelah 2xx;
  // pembelian belum di-consume tetap terlihat di restore (recovery).
  const redeemAndConsume = useCallback(async (p: Purchase): Promise<boolean> => {
    if (!p.orderId) {
      setErrorTerminal(false);
      setError('Google Play tidak mengirim orderId — tekan "Periksa pembelian" untuk mengulang.');
      return false;
    }
    setBusy({ productId: p.productId, phase: "verify" });
    busyRef.current = true;
    try {
      const data = await call<TopupIapRedeem>("topup_iap_redeem", {
        productId: p.productId,
        purchaseToken: p.purchaseToken,
        orderId: p.orderId,
      });
      setCredited({ tokens: data.tokens, balance: data.balance });
      setError(null);
      setErrorTerminal(false);
      void refreshTokenBalance();
      try {
        await consumePurchase(p.purchaseToken);
      } catch (consumeErr) {
        // Kredit sudah masuk; consume gagal bersih = recovery mount berikutnya
        // menutupnya (already_credited → consume). Jangan gagalkan UI.
        // Konsol + app.log + Sentry: pembelian sudah terkredit, hanya consume
        // yang tertinggal (recovery mount berikutnya menutupnya).
        logWarn("topup_iap_consume", consumeErr, { productId: p.productId, orderId: p.orderId });
      }
      return true;
    } catch (err) {
      const raw = errText(err);
      // Ditolak permanen (akun lain / produk salah / token terpakai): catat
      // supaya recovery tidak memutar ulang banner yang sama tiap mount.
      if (isTerminalTopupError(raw)) stuckRef.current.add(p.purchaseToken);
      logError("topup_iap_redeem", err, { productId: p.productId, orderId: p.orderId });
      setErrorTerminal(isTerminalTopupError(raw));
      setError(friendlyTopupError(raw));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  // ── Recovery — pembelian paid-but-unconsumed dari sesi/crash sebelumnya ──
  // Jalur yang sama menyelesaikan pembelian pending yang baru saja dibayar.
  const recoverPurchases = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    let resolved = false;
    let purchases: Purchase[] = [];
    try {
      ({ purchases } = await restorePurchases("inapp"));
    } catch {
      return false; // Play mungkin belum siap di mount pertama — abaikan.
    }
    for (const p of purchases) {
      if (p.purchaseState !== PurchaseState.PURCHASED) continue;
      if (stuckRef.current.has(p.purchaseToken)) continue;
      if (await redeemAndConsume(p)) {
        resolved = true;
        setPending(null);
      }
    }
    return resolved;
  }, [redeemAndConsume]);

  useEffect(() => {
    void recoverPurchases();
  }, [recoverPurchases]);

  // ── Polling pembelian pending ────────────────────────────────────────────
  useEffect(() => {
    if (pending == null) return;
    setPollExpired(false);
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
      if (ticks > PENDING_POLL_MAX_TICKS) {
        clearInterval(interval);
        // Berhenti memeriksa bukan hal yang boleh disembunyikan: banner
        // berhenti menjanjikan polling otomatis.
        setPollExpired(true);
        return;
      }
      void recoverPurchases().then((resolved) => {
        if (resolved) clearInterval(interval);
      });
    }, PENDING_POLL_MS);
    return () => clearInterval(interval);
  }, [pending, recoverPurchases]);

  // ── Beli ─────────────────────────────────────────────────────────────────
  const buy = useCallback(
    async (productId: string) => {
      if (busyRef.current) return;
      setError(null);
      setErrorTerminal(false);
      setCredited(null);
      setBusy({ productId, phase: "purchase" });
      busyRef.current = true;
      try {
        const result = await iapPurchase(productId, "inapp", {
          // Fraud prevention Google: bind pembelian ke akun — worker
          // mencocokkan obfuscatedExternalAccountId dengan sha256(email)
          // sesi (dihitung Rust-side, dikirim bersama flag channel).
          obfuscatedAccountId: accountHash,
        });
        if (result.purchaseState === PurchaseState.PURCHASED) {
          await redeemAndConsume(result);
        } else if (result.purchaseState === PurchaseState.PENDING) {
          setPending({ productId: result.productId, purchaseToken: result.purchaseToken });
        } else {
          setError("Pembelian dibatalkan.");
        }
      } catch (err) {
        const message = errText(err);
        // Tutup sheet pembayaran = bukan error, kembali diam-diam.
        if (!/cancel/i.test(message)) setError(message);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [accountHash, redeemAndConsume],
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section className="space-y-4">
      {credited && (
        <div className="rounded-md border border-success/20 bg-success/5 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-success">
            <Icon name="check-circle-2" className="size-4" />
            Pembelian berhasil — token masuk
          </p>
          <p className="text-muted-foreground">
            +{credited.tokens.toLocaleString("id-ID")} token · Saldo sekarang:{" "}
            {credited.balance.toLocaleString("id-ID")} token
          </p>
        </div>
      )}

      {pending && (
        <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <Icon name="alert-circle" className="size-4" />
            Menunggu pembayaran
          </p>
          <p className="text-muted-foreground">
            {pollExpired
              ? "Pemeriksaan otomatis berhenti setelah 30 menit. Buka ulang aplikasi atau tekan “Periksa pembelian” di bawah setelah pembayaran selesai."
              : "Selesaikan pembayaran (mis. kode bayar di minimarket/dompet digital). Token masuk otomatis begitu Google Play mengonfirmasi — diperiksa tiap 30 detik, atau buka ulang aplikasi nanti."}
          </p>
        </div>
      )}

      {error && (
        <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
          <p className="text-warning font-medium">Pembelian belum terkredit</p>
          <p className="text-muted-foreground break-words">{error}</p>
          {errorTerminal ? (
            <p className="text-muted-foreground">
              Pembelian ini tidak bisa dikreditkan ke akun ini — tidak akan dicoba ulang otomatis. Hubungi dukungan bila
              menurut Anda ini keliru.
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                Dana tidak hilang — pembelian yang sudah dibayar diambil otomatis saat halaman dibuka ulang.
              </p>
              <Button onClick={() => void recoverPurchases()} size="sm" variant="outline">
                <Icon name="rotate-ccw" className="size-3.5" />
                Periksa pembelian
              </Button>
            </>
          )}
        </div>
      )}

      <div className="rounded-lg border bg-[var(--tea-color-bg-primary-default)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">Nominal top-up</h3>
          <span className="text-muted-foreground text-xs">via Google Play</span>
        </div>

        {catalog == null && catalogError == null && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
        {catalogError != null && (
          <div className="space-y-2 text-sm">
            <p className="text-warning font-medium">Gagal memuat katalog</p>
            <p className="text-muted-foreground text-xs break-words">{catalogError}</p>
            <Button onClick={loadCatalog} size="sm" variant="outline">
              Coba lagi
            </Button>
          </div>
        )}
        {catalog != null && catalog.length === 0 && (
          <p className="text-muted-foreground text-sm">Katalog top-up belum tersedia.</p>
        )}
        {catalog != null && catalog.length > 0 && storeMissing && (
          <div className="space-y-2 text-xs">
            <p className="text-warning font-medium">Produk belum tersedia di Google Play</p>
            <p className="text-muted-foreground">
              Produk IAP ({catalog.map((p) => p.productId).join(", ")}) belum aktif di Play Console untuk akun ini —
              daftar di internal testing terlebih dulu, lalu periksa ulang.
            </p>
            <Button
              onClick={() => {
                setStoreAttempt((attempt) => attempt + 1);
              }}
              size="sm"
              variant="outline"
            >
              <Icon name="rotate-ccw" className="size-3.5" />
              Cek ulang
            </Button>
          </div>
        )}

        {catalog != null && catalog.length > 0 && (
          <ul className="space-y-2">
            {catalog.map((entry) => {
              const price = storePrices.get(entry.productId);
              const phase = busy?.productId === entry.productId ? busy.phase : null;
              return (
                <li className="flex items-center justify-between gap-3 rounded-md border p-3" key={entry.productId}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{price ? price : entry.productId}</span>
                    <span className="text-muted-foreground block text-xs">
                      +{entry.tokens.toLocaleString("id-ID")} token
                    </span>
                  </span>
                  <Button
                    className="shrink-0"
                    disabled={busy != null}
                    onClick={() => void buy(entry.productId)}
                    size="sm"
                  >
                    {phase != null && (
                      <>
                        <Spinner className="mr-1.5 size-3.5 animate-spin" />
                        {phase === "purchase" ? "Membuka Play…" : "Memverifikasi…"}
                      </>
                    )}
                    {phase == null && "Beli"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-muted-foreground mt-3 text-xs">
          Pembayaran diproses oleh Google Play Billing. Token ditambahkan setelah pembelian terverifikasi; pembelian
          belum selesai diambil ulang otomatis saat aplikasi dibuka.
        </p>
      </div>
    </section>
  );
}
