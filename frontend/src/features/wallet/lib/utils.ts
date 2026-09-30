export function safeParseFloat(v: string | number, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

export function getFaucetUrl(networkId?: number): string {
  const map: Record<number, string> = { 10143: "https://testnet.monad.xyz/faucet" };
  return map[networkId ?? 10143] ?? "https://testnet.monad.xyz/faucet";
}

export function getTxTypeColor(txType: string): string {
  const m: Record<string, string> = {
    DEPOSIT: "success",
    WITHDRAW: "destructive",
    SWAP: "default",
    TRANSFER: "secondary",
  };
  return m[txType] || "secondary";
}

export function getTxSign(txType: string): "+" | "-" | "" {
  if (txType === "DEPOSIT") return "+";
  if (txType === "WITHDRAW") return "-";
  return "";
}

export function shortAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}
