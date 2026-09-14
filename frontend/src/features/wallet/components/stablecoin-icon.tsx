import usdtLogo from "@/assets/usdt.svg";
import type { NetworkInfo } from "../lib/types";

const TOKEN_COLORS: Record<string, { branded: string; mono: string; glyph: string; glyphFontSize: string; letterSpacing: string }> = {
  usdt: { branded: "#009393", mono: "#6B7280", glyph: "₮", glyphFontSize: "18", letterSpacing: "0" },
  usdc: { branded: "#0B53BF", mono: "#6B7280", glyph: "$", glyphFontSize: "16", letterSpacing: "-0.5px" },
};

function TokenIcon({ token, size, variant }: { token: string; size: number; variant: "branded" | "mono" }) {
  const t = TOKEN_COLORS[token] ?? TOKEN_COLORS.usdt;
  const fill = variant === "mono" ? t.mono : t.branded;
  if (token === "usdt") {
    return <img src={usdtLogo} width={size} height={size} alt="USDT" className="block shrink-0" />;
  }

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={token.toUpperCase()}>
      <circle cx="16" cy="16" r="16" fill={fill} />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="white"
        fontSize={t.glyphFontSize}
        fontWeight="800"
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        style={{ letterSpacing: t.letterSpacing }}
      >
        {t.glyph}
      </text>
    </svg>
  );
}

export function StablecoinIcon({
  currentNetwork,
  size = 24,
  variant = "branded",
}: {
  currentNetwork: NetworkInfo | null;
  size?: number;
  variant?: "branded" | "mono";
}) {
  const isMainnet = currentNetwork && !currentNetwork.isTestnet;
  const token = isMainnet ? "usdc" : "usdt";

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      style={{ width: size, height: size }}
      title={isMainnet ? "USDC" : "USDT"}
    >
      <TokenIcon token={token} size={size} variant={variant} />
    </span>
  );
}
