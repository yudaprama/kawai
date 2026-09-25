import { useMemo } from "react";

import { QRCodeSVG } from "qrcode.react";

import gpnLogo from "@/assets/GPN.svg";

// ── QRIS standee-style card (mirror of the printed static QRIS look) ────────
// White card, QRIS wordmark + "QR Code Standar Pembayaran Nasional" header,
// GPN mark, merchant name + NMID from the payload itself, red ribbon accents.
// Merchant data is PARSED from `qrPayload` (EMVCo TLV) — never duplicated as
// frontend constants, so the card always matches what the wallet app reads.

/** Flat EMVCo TLV walk: "tag len value" × N → record. */
function parseTlv(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 4 <= payload.length; ) {
    const tag = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    out[tag] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** Tag 51 is QRIS's merchant slot — nested TLV: 00 issuer, 02 NMID, 03 UKE. */
function extractNmid(tag51: string | undefined): string | null {
  if (!tag51) return null;
  for (let i = 0; i + 4 <= tag51.length; ) {
    const tag = tag51.slice(i, i + 2);
    const len = Number(tag51.slice(i + 2, i + 4));
    if (tag === "02") return tag51.slice(i + 4, i + 4 + len) || null;
    i += 4 + len;
  }
  return null;
}

export interface QrisCardProps {
  /** Dynamic EMVCo payload from `topup_qris_claim` (tag 54 = exact amount). */
  qrPayload: string;
  /** Claim nominal in IDR — printed under the QR so the payer can verify. */
  amountLabel: string;
}

export function QrisCard({ qrPayload, amountLabel }: QrisCardProps) {
  const merchant = useMemo(() => {
    const tlv = parseTlv(qrPayload);
    return {
      // Tag 59 raw value keeps inner spaces ("TOKO KAWAI").
      name: (tlv["59"] ?? "").trim() || "MERCHANT",
      nmid: extractNmid(tlv["51"]),
      issuer: extractIssuer(tlv["51"]),
    };
  }, [qrPayload]);

  return (
    <div className="relative w-[264px] shrink-0 overflow-hidden rounded-xl bg-white p-4 text-black shadow-sm">
      {/* Red ribbon accents — left chevron + bottom-right corner, like the standee */}
      <div
        aria-hidden
        className="absolute top-0 left-0 h-full w-3 bg-[#d7282f]"
        style={{ clipPath: "polygon(0 0, 100% 12%, 100% 34%, 0 58%)" }}
      />
      <div
        aria-hidden
        className="absolute right-0 bottom-0 h-16 w-16 bg-[#d7282f]"
        style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
      />

      {/* Header: QRIS wordmark + national standard title, GPN mark right */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative text-2xl leading-none font-black tracking-tighter">
            {/* Corner brackets around the wordmark, QRIS-logo style */}
            <span aria-hidden className="absolute top-0 left-0 h-1.5 w-1.5 border-t-2 border-l-2 border-black" />
            <span aria-hidden className="absolute top-0 right-0 h-1.5 w-1.5 border-t-2 border-r-2 border-black" />
            <span aria-hidden className="absolute bottom-0 left-0 h-1.5 w-1.5 border-b-2 border-l-2 border-black" />
            <span aria-hidden className="absolute right-0 bottom-0 h-1.5 w-1.5 border-r-2 border-b-2 border-black" />
            <span className="px-1">QRIS</span>
          </span>
          <p className="text-[10px] leading-tight font-bold">
            QR Code Standar
            <br />
            Pembayaran Nasional
          </p>
        </div>
        <img src={gpnLogo} alt="GPN" className="h-7 w-auto" />
      </div>

      {/* Merchant identity — from the payload, not constants */}
      <div className="mt-3 text-center">
        <p className="text-lg leading-tight font-bold tracking-wide">{merchant.name}</p>
        {merchant.nmid ? <p className="text-[11px] text-gray-600">NMID: {merchant.nmid}</p> : null}
      </div>

      {/* The dynamic QR — wallet apps read the exact prefilled amount */}
      <div className="mt-3 flex justify-center">
        <QRCodeSVG value={qrPayload} size={208} marginSize={0} />
      </div>

      {/* Amount + issuer footer — left slot, clear of the red corner accent */}
      <p className="mt-3 text-center text-lg font-extrabold">{amountLabel}</p>
      <p className="mt-1 text-[9px] text-gray-500">{merchant.issuer ?? ""}</p>
    </div>
  );
}

function extractIssuer(tag51: string | undefined): string | null {
  if (!tag51) return null;
  for (let i = 0; i + 4 <= tag51.length; ) {
    const tag = tag51.slice(i, i + 2);
    const len = Number(tag51.slice(i + 2, i + 4));
    if (tag === "00") return tag51.slice(i + 4, i + 4 + len) || null;
    i += 4 + len;
  }
  return null;
}
