export function safeParseFloat(v: string | number, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const past = new Date(date);
  if (Number.isNaN(past.getTime())) return "-";
  const sec = Math.floor((now.getTime() - past.getTime()) / 1000);
  if (sec < 0) return "Just now";
  if (sec < 60) return "Just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return past.toLocaleDateString();
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
