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
import { call, errText, type TopupIapProduct, type TopupIapProducts, type TopupIapRedeem } from "@/lib/api";

/** Jeda polling pembelian pending (bayar di minimarket/GoPay bisa berjam-jam). */
const PENDING_POLL_MS = 30_000;
/** Batas polling per sesi halaman — setelah itu banner menyarankan buka ulang
 *  aplikasi (recovery mount mengkredit pembelian yang sudah dibayar). */
const PENDING_POLL_MAX_TICKS = 60;

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
  const [pending, setPending] = useState<{ productId: string; purchaseToken: string } | null>(null);
  const busyRef = useRef(false);

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    call<TopupIapProducts>("topup_iap_products")
      .then(({ products }) => setCatalog(products))
      .catch((err) => {
        setCatalog(null);
        setCatalogError(errText(err));
      });
  }, []);
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // Harga Play untuk produk katalog — sekali per katalog. Daftar kosong berarti
  // produk IAP belum dibuat di Play Console (bukan error UI).
  useEffect(() => {
    if (catalog == null || catalog.length === 0) return;
    let cancelled = false;
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
  }, [catalog]);

  // ── Verify + credit + consume ────────────────────────────────────────────
  // Idempoten di worker (per orderId) — retry aman. consume HANYA setelah 2xx;
  // pembelian belum di-consume tetap terlihat di restore (recovery).
  const redeemAndConsume = useCallback(async (p: Purchase): Promise<boolean> => {
    if (!p.orderId) {
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
      void refreshTokenBalance();
      try {
        await consumePurchase(p.purchaseToken);
      } catch (consumeErr) {
        // Kredit sudah masuk; consume gagal bersih = recovery mount berikutnya
        // menutupnya (already_credited → consume). Jangan gagalkan UI.
        console.warn("consumePurchase gagal (pembelian tetap terkredit):", errText(consumeErr));
      }
      return true;
    } catch (err) {
      setError(errText(err));
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
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
      if (ticks > PENDING_POLL_MAX_TICKS) {
        clearInterval(interval);
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
            Selesaikan pembayaran (mis. kode bayar di minimarket/dompet digital). Token masuk otomatis begitu Google
            Play mengonfirmasi — diperiksa tiap 30 detik, atau buka ulang aplikasi nanti.
          </p>
        </div>
      )}

      {error && (
        <div className="border-warning/30 space-y-1 rounded-md border p-3 text-xs">
          <p className="text-warning font-medium">Pembelian belum terkredit</p>
          <p className="text-muted-foreground font-mono break-words">{error}</p>
          <p className="text-muted-foreground">
            Dana tidak hilang — pembelian yang sudah dibayar diambil otomatis saat halaman dibuka ulang.
          </p>
          <Button onClick={() => void recoverPurchases()} size="sm" variant="outline">
            <Icon name="rotate-ccw" className="size-3.5" />
            Periksa pembelian
          </Button>
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
            <p className="text-muted-foreground font-mono text-xs break-words">{catalogError}</p>
            <Button onClick={loadCatalog} size="sm" variant="outline">
              Coba lagi
            </Button>
          </div>
        )}
        {catalog != null && catalog.length === 0 && (
          <p className="text-muted-foreground text-sm">Katalog top-up belum tersedia.</p>
        )}
        {catalog != null && catalog.length > 0 && storeMissing && (
          <div className="space-y-1 text-xs">
            <p className="text-warning font-medium">Produk belum tersedia di Google Play</p>
            <p className="text-muted-foreground">
              Produk IAP ({catalog.map((p) => p.productId).join(", ")}) belum aktif di Play Console untuk akun ini —
              daftar di internal testing terlebih dulu, lalu muat ulang.
            </p>
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
