import { Icon } from "@/components/shared/icon";
import monadLogo from "@/assets/monad.svg";

type Props = { name: string; size?: number };

const SVG_LOGOS: Record<string, string> = {
  monad: monadLogo as unknown as string,
};

const COLOR_MAP: Record<string, string> = {
  ethereum: "bg-[#627EEA]",
  monad: "bg-[#200052]",
  base: "bg-[#0052FF]",
  arbitrum: "bg-[#28A0F0]",
  optimism: "bg-[#FF0420]",
  "binance-smart-chain": "bg-[#F3BA2F]",
  polygon: "bg-[#8247E5]",
};

export function NetworkIcon({ name, size = 24 }: Props) {
  const svgSrc = SVG_LOGOS[name];
  if (svgSrc) {
    return (
      <span
        aria-hidden
        className="inline-flex items-center justify-center overflow-hidden rounded-full"
        style={{ width: size, height: size }}
      >
        <img src={svgSrc} width={size} height={size} alt="" className="block" />
      </span>
    );
  }

  const bg = COLOR_MAP[name] ?? "bg-muted-foreground";
  const label = name.slice(0, 3).toUpperCase();
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-full text-white text-[10px] font-bold ${bg}`}
      style={{ width: size, height: size }}
    >
      {label}
    </span>
  );
}

// fallback for unknown without web3icons dep — keep bundle light
export function NetworkIconFallback({ size = 24 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground"
      style={{ width: size, height: size }}
    >
      <Icon name="coins" className="size-3" />
    </span>
  );
}
