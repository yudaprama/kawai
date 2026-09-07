import type { NetworkInfo } from "../lib/types";

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
  const label = isMainnet ? "USDC" : "USDT";

  // mono = muted gray, branded = token colors (veridium: TokenUSDT #26A17B, TokenUSDC #2775CA)
  const fill = variant === "mono" ? "#6B7280" : isMainnet ? "#2775CA" : "#26A17B";
  // USDT uses ₮ (Tether), USDC uses $
  const glyph = isMainnet ? "$" : "₮";

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size }}
      title={label}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={label}>
        <circle cx="16" cy="16" r="16" fill={fill} />
        <text
          x="16"
          y="21"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="white"
          fontSize={isMainnet ? "16" : "18"}
          fontWeight="800"
          fontFamily="Inter, system-ui, -apple-system, sans-serif"
          style={{ letterSpacing: isMainnet ? "-0.5px" : "0" }}
        >
          {glyph}
        </text>
      </svg>
    </span>
  );
}
