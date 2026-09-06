import type { NetworkInfo } from "../lib/types";

export function StablecoinIcon({ currentNetwork, size = 24 }: { currentNetwork: NetworkInfo | null; size?: number }) {
  const isMainnet = currentNetwork && !currentNetwork.isTestnet;
  const label = isMainnet ? "USDC" : "USDT";
  const bg = isMainnet ? "bg-[#2775CA]" : "bg-[#26A17B]";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-white font-bold ${bg}`}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.35) }}
      aria-label={label}
    >
      $
    </span>
  );
}
