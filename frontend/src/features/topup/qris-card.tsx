import { useCallback, useMemo, useRef } from "react";

import { QRCodeSVG } from "qrcode.react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { triggerDownload } from "@/lib/download";
import gpnLogo from "@/assets/GPN.svg";
import qrisLogo from "@/assets/QRIS-withtext.svg";

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

/** Convert an SVG element to a PNG blob (for QR code download). */
async function svgToPngBlob(svg: SVGSVGElement, scale = 3): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const width = svg.width.baseVal.value || 208;
  const height = svg.height.baseVal.value || 208;

  clone.setAttribute("width", String(width * scale));
  clone.setAttribute("height", String(height * scale));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const svgData = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      reject(new Error("Canvas 2D context unavailable"));
      return;
    }
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG conversion failed"));
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error("SVG image load failed"));
  };
  img.src = url;
  return promise;
}

export interface QrisCardProps {
  /** Dynamic EMVCo payload from `topup_qris_claim` (tag 54 = exact amount). */
  qrPayload: string;
  /** Claim nominal in IDR — printed under the QR so the payer can verify. */
  amountLabel: string;
}

export function QrisCard({ qrPayload, amountLabel }: QrisCardProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  const merchant = useMemo(() => {
    const tlv = parseTlv(qrPayload);
    return {
      // Tag 59 raw value keeps inner spaces ("TOKO KAWAI").
      name: (tlv["59"] ?? "").trim() || "MERCHANT",
      nmid: extractNmid(tlv["51"]),
      issuer: extractIssuer(tlv["51"]),
    };
  }, [qrPayload]);

  const handleDownload = useCallback(async () => {
    const svg = qrRef.current?.querySelector("svg");
    if (!svg) return;
    try {
      const blob = await svgToPngBlob(svg);
      triggerDownload("qris-topup.png", blob, "image/png");
    } catch {
      // best-effort — download silently fails
    }
  }, []);

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative w-[264px] shrink-0 overflow-hidden rounded-xl bg-white p-4 text-black shadow-sm border"
        ref={qrRef}
      >
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

        {/* Header: real QRIS lockup + GPN mark right */}
        <div className="flex items-start justify-between gap-2">
          <img src={qrisLogo} alt="QRIS — QR Code Standar Pembayaran Nasional" className="h-6 w-auto" />
          <img src={gpnLogo} alt="GPN" className="h-7 w-auto" />
        </div>

        {/* Merchant identity — from the payload, not constants */}
        <div className="mt-3 text-center">
          <p className="text-lg leading-tight font-bold tracking-wide">{merchant.name}</p>
          {merchant.nmid ? <p className="text-[11px] text-muted-foreground">NMID: {merchant.nmid}</p> : null}
        </div>

        {/* The dynamic QR — wallet apps read the exact prefilled amount */}
        <div className="mt-3 flex justify-center">
          <QRCodeSVG value={qrPayload} size={208} marginSize={0} />
        </div>

        {/* Amount + issuer footer — left slot, clear of the red corner accent */}
        <p className="mt-3 text-center text-lg font-extrabold">{amountLabel}</p>
        <p className="mt-1 text-[9px] text-gray-500">{merchant.issuer ?? ""}</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void handleDownload()} className="w-[264px]">
        <Icon name="download" className="size-3.5" />
        Download QR
      </Button>
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
